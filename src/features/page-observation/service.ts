import { browser, type Browser } from 'wxt/browser';
import { scriptingTarget } from '@/platform/browser/targets';
import type {
  BrowserTarget, PageObservationOptions, PageObservationRecord, PageObservationStatus,
} from '@/types/models';
import { ExtensionError } from '@/shared/errors';

const OBSERVER_SCRIPT = '/page-observer-main-world.js' as const;
const DEFAULT_OPTIONS: PageObservationOptions = { captureValues: false, maxEntries: 100, maxValueBytes: 2_048 };
const MAX_ENTRIES = 200;

interface PageObserverSnapshot {
  version: 2;
  active: boolean;
  startedAt?: number;
  count: number;
  droppedCount: number;
  options?: PageObservationOptions;
  records: PageObservationRecord[];
}

interface OwnedObservation {
  target: BrowserTarget;
  owner: { kind: 'local' } | { kind: 'grant'; grantId: string };
}

type ObserverCommand = 'start' | 'status' | 'list' | 'clear' | 'stop';
const ownedObservations = new Map<string, OwnedObservation>();

function targetKey(target: BrowserTarget): string {
  return `${target.tabId}:${target.frameId}`;
}

function pageObserverCommand(command: ObserverCommand, input: Record<string, unknown>): unknown {
  const controller = (window as unknown as Record<string, unknown>).__YAKIT_PAGE_OBSERVER_V2__ as {
    version?: unknown;
    command?: (name: ObserverCommand, params: Record<string, unknown>) => unknown;
  } | undefined;
  if (controller?.version !== 2 || typeof controller.command !== 'function') {
    if (command === 'status') return { version: 2, active: false, count: 0, droppedCount: 0, records: [] };
    throw new Error('页面观测器未安装');
  }
  return controller.command(command, input);
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, maxLength) : undefined;
}

function normalizeOptions(input?: Partial<PageObservationOptions>): PageObservationOptions {
  return {
    captureValues: input?.captureValues === true,
    maxEntries: Math.max(10, Math.min(Math.floor(input?.maxEntries || DEFAULT_OPTIONS.maxEntries), MAX_ENTRIES)),
    maxValueBytes: Math.max(256, Math.min(Math.floor(input?.maxValueBytes || DEFAULT_OPTIONS.maxValueBytes), 8_192)),
    expiresAt: typeof input?.expiresAt === 'number' && Number.isFinite(input.expiresAt) ? input.expiresAt : undefined,
  };
}

function normalizeRecord(value: unknown, allowSensitive: boolean): PageObservationRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  const kinds = ['fetch', 'xhr', 'form', 'websocket', 'webcrypto', 'cryptojs'] as const;
  if (typeof input.id !== 'string' || !kinds.includes(input.kind as typeof kinds[number]) || typeof input.operation !== 'string') return undefined;
  const output = {
    id: input.id.slice(0, 160),
    sequence: Math.max(0, Math.floor(finiteNumber(input.sequence))),
    timestamp: finiteNumber(input.timestamp),
    kind: input.kind as PageObservationRecord['kind'],
    operation: input.operation.slice(0, 160),
    sensitiveCaptured: allowSensitive && input.sensitiveCaptured === true,
  } as PageObservationRecord & Record<string, unknown>;
  const stringLimits: Record<string, number> = {
    url: 8_192, method: 32, algorithm: 240, socketId: 160, dataType: 120,
    stack: 4_096, scriptUrl: 2_048, error: 512,
  };
  for (const [key, limit] of Object.entries(stringLimits)) {
    const normalized = optionalString(input[key], limit);
    if (normalized !== undefined) output[key] = normalized;
  }
  if (input.direction === 'send' || input.direction === 'receive') output.direction = input.direction;
  for (const key of ['byteLength', 'resultByteLength'] as const) {
    if (input[key] !== undefined) output[key] = Math.max(0, finiteNumber(input[key]));
  }
  if (allowSensitive) {
    output.inputPreview = optionalString(input.inputPreview, 8_192);
    output.outputPreview = optionalString(input.outputPreview, 8_192);
  }
  return output;
}

function normalizeSnapshot(value: unknown, allowSensitive: boolean): PageObserverSnapshot {
  if (!value || typeof value !== 'object') throw new ExtensionError('observer_unavailable', '页面观测器返回了无效状态');
  const input = value as Record<string, unknown>;
  if (input.version !== 2 || typeof input.active !== 'boolean' || !Array.isArray(input.records)) {
    throw new ExtensionError('observer_unavailable', '页面观测器协议不兼容');
  }
  const pageOptions = input.options && typeof input.options === 'object'
    ? normalizeOptions(input.options as Partial<PageObservationOptions>)
    : undefined;
  return {
    version: 2,
    active: input.active,
    startedAt: input.startedAt === undefined ? undefined : finiteNumber(input.startedAt),
    count: Math.max(0, Math.floor(finiteNumber(input.count))),
    droppedCount: Math.max(0, Math.floor(finiteNumber(input.droppedCount))),
    options: pageOptions,
    records: input.records.slice(-MAX_ENTRIES).map((item) => normalizeRecord(item, allowSensitive)).filter((item): item is PageObservationRecord => Boolean(item)),
  };
}

async function executeCommand(
  target: BrowserTarget,
  command: ObserverCommand,
  input: Record<string, unknown> = {},
  allowSensitive = false,
): Promise<PageObserverSnapshot> {
  let results: Browser.scripting.InjectionResult[];
  try {
    results = await browser.scripting.executeScript({
      target: scriptingTarget(target),
      world: 'MAIN',
      func: pageObserverCommand,
      args: [command, input],
    });
  } catch (error) {
    throw new ExtensionError('observer_unavailable', error instanceof Error ? error.message : String(error));
  }
  if (results.length !== 1) throw new ExtensionError('observer_unavailable', '页面观测器无法唯一定位目标文档');
  return normalizeSnapshot(results[0].result, allowSensitive);
}

async function install(target: BrowserTarget): Promise<void> {
  try {
    await browser.scripting.executeScript({ target: scriptingTarget(target), world: 'MAIN', files: [OBSERVER_SCRIPT] });
  } catch (error) {
    throw new ExtensionError('observer_unavailable', error instanceof Error ? error.message : String(error));
  }
}

function statusFrom(target: BrowserTarget, snapshot: PageObserverSnapshot): PageObservationStatus {
  return {
    active: snapshot.active,
    target,
    startedAt: snapshot.startedAt,
    count: snapshot.count,
    droppedCount: snapshot.droppedCount,
    options: snapshot.options,
  };
}

export async function startPageObservation(
  target: BrowserTarget,
  input?: Partial<PageObservationOptions>,
  owner: OwnedObservation['owner'] = { kind: 'local' },
): Promise<PageObservationStatus> {
  const options = normalizeOptions(input);
  await install(target);
  const snapshot = await executeCommand(target, 'start', { ...options }, options.captureValues);
  ownedObservations.set(targetKey(target), { target, owner });
  return statusFrom(target, snapshot);
}

export async function pageObservationStatus(target: BrowserTarget): Promise<PageObservationStatus> {
  try {
    return statusFrom(target, await executeCommand(target, 'status'));
  } catch (error) {
    if (error instanceof ExtensionError && error.code === 'observer_unavailable') {
      return { active: false, target, count: 0, droppedCount: 0 };
    }
    throw error;
  }
}

export async function listPageObservations(target: BrowserTarget, limit = 100, allowSensitive = false): Promise<PageObservationRecord[]> {
  const snapshot = await executeCommand(target, 'list', { limit: Math.max(1, Math.min(Math.floor(limit), MAX_ENTRIES)) }, allowSensitive);
  return snapshot.records;
}

export async function clearPageObservations(target: BrowserTarget): Promise<PageObservationStatus> {
  return statusFrom(target, await executeCommand(target, 'clear'));
}

export async function stopPageObservation(target: BrowserTarget): Promise<PageObservationStatus> {
  const snapshot = await executeCommand(target, 'stop').catch(() => undefined);
  ownedObservations.delete(targetKey(target));
  return snapshot ? statusFrom(target, snapshot) : { active: false, target, count: 0, droppedCount: 0 };
}

export async function stopPageObservationsForGrant(grantId: string): Promise<void> {
  const matches = [...ownedObservations.values()].filter((item) => item.owner.kind === 'grant' && item.owner.grantId === grantId);
  await Promise.allSettled(matches.map((item) => stopPageObservation(item.target)));
}

export async function observationAnalysisWindow(target: BrowserTarget, centerTimestamp: number): Promise<Array<Pick<
  PageObservationRecord,
  'kind' | 'operation' | 'algorithm' | 'direction' | 'scriptUrl' | 'byteLength' | 'resultByteLength' | 'timestamp'
>>> {
  const records = await listPageObservations(target, MAX_ENTRIES, false).catch(() => []);
  return records.filter((item) => Math.abs(item.timestamp - centerTimestamp) <= 60_000).map((item) => ({
    kind: item.kind,
    operation: item.operation,
    algorithm: item.algorithm,
    direction: item.direction,
    scriptUrl: item.scriptUrl,
    byteLength: item.byteLength,
    resultByteLength: item.resultByteLength,
    timestamp: item.timestamp,
  }));
}

browser.tabs.onRemoved.addListener((tabId) => {
  for (const [key, observation] of ownedObservations) if (observation.target.tabId === tabId) ownedObservations.delete(key);
});
