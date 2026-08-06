import { browser } from 'wxt/browser';
import type {
  BrowserPageCallable,
  BrowserPageCallableExecution,
  BrowserTarget,
  BrowserTransformDirection,
  BrowserTransformDirectionName,
  BrowserTransformExecution,
  BrowserTransformPacket,
} from '@/types/models';
import { ExtensionError } from '@/shared/errors';
import { resolveDocumentTarget, scriptingTarget } from '@/platform/browser/targets';
import { PAGE_RECORDER_PROTOCOL_VERSION, PAGE_RECORDER_REGISTRY_KEY } from '@/features/browser-recording/constants';
import { executeFirefoxPageRecorderCommand } from '@/features/browser-recording/bridge-client';
import { normalizeBrowserRecordingCrypto } from '@/features/browser-crypto/model';
import {
  MAX_CALLABLE_TIMEOUT_MS,
  MIN_CALLABLE_TIMEOUT_MS,
  callableExecutionPolicy,
} from './execution';

const MAX_CALLABLES = 128;

type RawCallable = Omit<BrowserPageCallable, 'target'> & { target?: BrowserTarget };

function normalizeTransaction(value: unknown): BrowserPageCallable['transaction'] {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<NonNullable<BrowserPageCallable['transaction']>>;
  const request = input.request as Partial<NonNullable<BrowserPageCallable['transaction']>['request']> | undefined;
  if (input.version !== 2 || !Array.isArray(input.prerequisites) || input.prerequisites.length > 4
    || !request || !['fetch', 'xhr', 'beacon', 'form'].includes(String(request.boundary))
    || typeof request.method !== 'string' || typeof request.url !== 'string'
    || !Array.isArray(request.expectedDestinations) || request.expectedDestinations.length === 0
    || request.expectedDestinations.some((item) => typeof item !== 'string' || !item.trim())
    || !['json', 'form', 'raw'].includes(String(request.bodyFormat))) return undefined;
  const prerequisites = input.prerequisites.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Partial<NonNullable<BrowserPageCallable['transaction']>['prerequisites'][number]>;
    const response = item.response as Partial<NonNullable<BrowserPageCallable['transaction']>['prerequisites'][number]['response']> | undefined;
    if (item.boundary !== 'fetch' || typeof item.method !== 'string' || typeof item.url !== 'string'
      || !['none', 'json', 'form', 'raw'].includes(String(item.requestBodyFormat))
      || !Number.isSafeInteger(item.maxRequestBodyBytes) || Number(item.maxRequestBodyBytes) < 0
      || Number(item.maxRequestBodyBytes) > 8 * 1_024 * 1_024
      || !response || !Number.isSafeInteger(response.statusCode) || Number(response.statusCode) < 100
      || Number(response.statusCode) > 599 || typeof response.url !== 'string'
      || !['json', 'form', 'raw'].includes(String(response.bodyFormat))
      || !Number.isSafeInteger(response.maxBodyBytes) || Number(response.maxBodyBytes) < 1
      || Number(response.maxBodyBytes) > 8 * 1_024 * 1_024
      || !Array.isArray(response.requiredPaths) || response.requiredPaths.length === 0
      || response.requiredPaths.some((path) => typeof path !== 'string' || !path.trim())) return [];
    return [{
      boundary: 'fetch' as const,
      method: item.method.toUpperCase().slice(0, 16),
      url: item.url.slice(0, 4_096),
      requestBodyFormat: item.requestBodyFormat as NonNullable<BrowserPageCallable['transaction']>['prerequisites'][number]['requestBodyFormat'],
      maxRequestBodyBytes: Number(item.maxRequestBodyBytes),
      response: {
        statusCode: Number(response.statusCode),
        url: response.url.slice(0, 4_096),
        bodyFormat: response.bodyFormat as NonNullable<BrowserPageCallable['transaction']>['prerequisites'][number]['response']['bodyFormat'],
        maxBodyBytes: Number(response.maxBodyBytes),
        requiredPaths: [...new Set(response.requiredPaths.map((path) => path.trim().slice(0, 512)))].slice(0, 64),
      },
    }];
  });
  if (prerequisites.length !== input.prerequisites.length) return undefined;
  return {
    version: 2,
    prerequisites,
    request: {
      boundary: request.boundary as NonNullable<BrowserPageCallable['transaction']>['request']['boundary'],
      method: request.method.toUpperCase().slice(0, 16),
      url: request.url.slice(0, 4_096),
      expectedDestinations: [...new Set(request.expectedDestinations.map((item) => item.trim().slice(0, 512)))].slice(0, 64),
      bodyFormat: request.bodyFormat as NonNullable<BrowserPageCallable['transaction']>['request']['bodyFormat'],
    },
    inputMode: 'auto',
  };
}

function normalizeExecution(value: unknown): BrowserPageCallable['execution'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<BrowserPageCallable['execution']>;
  if (!['sync', 'promise', 'auto'].includes(String(input.resultMode))
    || !Number.isSafeInteger(input.timeoutMs)
    || Number(input.timeoutMs) < MIN_CALLABLE_TIMEOUT_MS
    || Number(input.timeoutMs) > MAX_CALLABLE_TIMEOUT_MS) return undefined;
  return callableExecutionPolicy(input.resultMode as BrowserPageCallable['execution']['resultMode'], Number(input.timeoutMs));
}

function normalizeCallableAnalysis(
  value: unknown,
): BrowserPageCallable['provenance']['analysis'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<NonNullable<BrowserPageCallable['provenance']['analysis']>>;
  if (input.version !== 1 || typeof input.traceId !== 'string'
    || !input.confidence || typeof input.confidence !== 'object'
    || !Number.isFinite(input.confidence.score)
    || !['high', 'medium', 'low'].includes(String(input.confidence.level))
    || !Array.isArray(input.flow) || !Array.isArray(input.operations) || !Array.isArray(input.evidence)) return undefined;
  const evidenceKinds = new Set([
    'request-boundary', 'response-boundary', 'exact-value', 'message-boundary',
    'state-sequence', 'transform-lineage', 'callable', 'trace-order', 'heuristic',
  ]);
  return {
    version: 1,
    traceId: input.traceId.slice(0, 160),
    confidence: {
      score: Math.max(0, Math.min(100, Number(input.confidence.score))),
      level: input.confidence.level as 'high' | 'medium' | 'low',
    },
    flow: input.flow.slice(0, 32).flatMap((item) => typeof item === 'string' ? [item.slice(0, 240)] : []),
    operations: input.operations.slice(0, 16).flatMap((operation) => (
      operation && typeof operation.operation === 'string'
        ? [{
          operation: operation.operation.slice(0, 240),
          destination: typeof operation.destination === 'string' ? operation.destination.slice(0, 512) : undefined,
          crypto: normalizeBrowserRecordingCrypto(operation.crypto),
        }]
        : []
    )),
    evidence: input.evidence.slice(0, 24).flatMap((item) => (
      item && evidenceKinds.has(String(item.kind))
        && ['proven', 'supported'].includes(String(item.strength))
        && typeof item.label === 'string'
        ? [{
          kind: item.kind,
          strength: item.strength,
          label: item.label.slice(0, 500),
        }]
        : []
    )),
  };
}

function normalizeCallable(value: unknown, target: BrowserTarget): BrowserPageCallable | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<RawCallable>;
  if (typeof input.id !== 'string' || typeof input.name !== 'string'
    || !['recorded-call', 'business-closure', 'request-transaction', 'global-function'].includes(String(input.kind))
    || typeof input.operation !== 'string' || typeof input.origin !== 'string'
    || input.lifecycle !== 'document' || !Array.isArray(input.inputSlots)
    || !input.output || typeof input.output !== 'object' || !input.provenance || typeof input.provenance !== 'object') return undefined;
  const transaction = normalizeTransaction(input.transaction);
  const execution = normalizeExecution(input.execution);
  if (!execution) return undefined;
  if (input.kind === 'request-transaction' && !transaction) return undefined;
  const outputShape = input.output.shape;
  const outputPaths = input.output.paths;
  if (!['value', 'envelope'].includes(String(outputShape)) || !Array.isArray(outputPaths)
    || outputPaths.some((item) => typeof item !== 'string')
    || (outputShape === 'envelope' && outputPaths.length === 0)) return undefined;
  if (input.kind === 'request-transaction') {
    const expected = [...new Set(transaction!.request.expectedDestinations)].sort();
    const declared = [...new Set(outputPaths)].sort();
    if (outputShape !== 'envelope' || expected.length !== declared.length
      || expected.some((path, index) => path !== declared[index])) return undefined;
  }
  return {
    id: input.id.slice(0, 160),
    name: input.name.slice(0, 120),
    kind: input.kind as BrowserPageCallable['kind'],
    operation: input.operation.slice(0, 240),
    algorithm: typeof input.algorithm === 'string' ? input.algorithm.slice(0, 240) : undefined,
    crypto: normalizeBrowserRecordingCrypto(input.crypto),
    origin: input.origin.slice(0, 2_048),
    target: { ...target },
    lifecycle: 'document',
    execution,
    inputSlots: input.inputSlots.slice(0, 64).map((slot, index) => {
      const item = slot as Partial<BrowserPageCallable['inputSlots'][number]>;
      return {
        id: typeof item.id === 'string' ? item.id.slice(0, 120) : `arg-${index}`,
        name: typeof item.name === 'string' ? item.name.slice(0, 120) : `arg${index}`,
        index: Number.isSafeInteger(item.index) ? Number(item.index) : index,
        role: ['data', 'key', 'iv', 'algorithm', 'options', 'signature', 'salt', 'nonce', 'aad', 'unknown'].includes(String(item.role))
          ? item.role as BrowserPageCallable['inputSlots'][number]['role'] : 'unknown',
        dataType: typeof item.dataType === 'string' ? item.dataType.slice(0, 120) : 'unknown',
        required: item.required !== false,
        retained: item.retained === true,
      };
    }),
    output: {
      dataType: typeof input.output.dataType === 'string' ? input.output.dataType.slice(0, 120) : 'unknown',
      encoding: ['auto', 'utf8', 'hex', 'base64', 'json'].includes(String(input.output.encoding))
        ? input.output.encoding as BrowserPageCallable['output']['encoding'] : 'auto',
      shape: outputShape as BrowserPageCallable['output']['shape'],
      paths: outputPaths.slice(0, 64).map((item) => item.slice(0, 512)),
    },
    transaction,
    provenance: {
      recordingId: typeof input.provenance.recordingId === 'string' ? input.provenance.recordingId.slice(0, 160) : undefined,
      traceId: typeof input.provenance.traceId === 'string' ? input.provenance.traceId.slice(0, 160) : undefined,
      eventId: typeof input.provenance.eventId === 'string' ? input.provenance.eventId.slice(0, 160) : undefined,
      sourceUrl: typeof input.provenance.sourceUrl === 'string' ? input.provenance.sourceUrl.slice(0, 4_096) : undefined,
      lineNumber: Number.isSafeInteger(input.provenance.lineNumber) ? Math.max(1, Number(input.provenance.lineNumber)) : undefined,
      functionName: typeof input.provenance.functionName === 'string' ? input.provenance.functionName.slice(0, 240) : undefined,
      businessFrameHints: Array.isArray(input.provenance.businessFrameHints)
        ? input.provenance.businessFrameHints.slice(0, 16).flatMap((hint) => (
          hint
          && typeof hint.functionName === 'string'
          && Number.isFinite(hint.support)
          && Number.isFinite(hint.averageDepth)
            ? [{
              functionName: hint.functionName.slice(0, 240),
              url: typeof hint.url === 'string' ? hint.url.slice(0, 4_096) : undefined,
              support: Math.max(0, Number(hint.support)),
              averageDepth: Math.max(0, Number(hint.averageDepth)),
            }]
            : []
        ))
        : undefined,
      analysis: normalizeCallableAnalysis(input.provenance.analysis),
    },
    createdAt: Number.isFinite(input.createdAt) ? Math.max(0, Number(input.createdAt)) : Date.now(),
  };
}

type PageControllerCommand = 'callable.list' | 'callable.execute' | 'callable.delete' | 'transform.execute';

function injectionErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') {
    return (value as { message: string }).message;
  }
  return String(value || '页面脚本执行失败');
}

async function pageCallableCommand(
  registryKey: string,
  protocolVersion: number,
  command: PageControllerCommand,
  input: Record<string, unknown>,
): Promise<unknown> {
  const controller = (window as unknown as Record<string, unknown>)[registryKey] as {
    version?: unknown;
    command?: (name: PageControllerCommand, params: Record<string, unknown>) => unknown;
  } | undefined;
  if (controller?.version !== protocolVersion || typeof controller.command !== 'function') {
    if (command === 'callable.list') return [];
    throw new Error('页面函数控制器不存在，页面可能已经刷新');
  }
  return await Promise.resolve(controller.command(command, input));
}

async function callPageController(
  target: BrowserTarget,
  command: PageControllerCommand,
  input: Record<string, unknown> = {},
): Promise<unknown> {
  if (import.meta.env.FIREFOX) return executeFirefoxPageRecorderCommand(target, command, input);
  const [result] = await browser.scripting.executeScript({
    target: scriptingTarget(target),
    world: 'MAIN',
    func: pageCallableCommand,
    args: [PAGE_RECORDER_REGISTRY_KEY, PAGE_RECORDER_PROTOCOL_VERSION, command, input],
  });
  const injectionError = (result as (typeof result & { error?: unknown }) | undefined)?.error;
  if (injectionError !== undefined) {
    throw new ExtensionError('page_callable_execution_failed', injectionErrorMessage(injectionError));
  }
  return result?.result;
}

export async function listPageCallables(target: BrowserTarget): Promise<BrowserPageCallable[]> {
  const resolved = await resolveDocumentTarget(target);
  const result = await callPageController(resolved, 'callable.list');
  if (!Array.isArray(result)) return [];
  return result.map((item) => normalizeCallable(item, resolved))
    .filter((item): item is BrowserPageCallable => Boolean(item)).slice(-MAX_CALLABLES);
}

export async function executePageCallable(
  target: BrowserTarget,
  callableId: string,
  args: unknown[],
): Promise<BrowserPageCallableExecution> {
  const resolved = await resolveDocumentTarget(target);
  const value = await callPageController(resolved, 'callable.execute', { callableId, args }) as BrowserPageCallableExecution | undefined;
  if (!value || value.callableId !== callableId || typeof value.durationMs !== 'number') {
    throw new ExtensionError('callable_invalid_result', '页面函数没有返回有效结果');
  }
  return value;
}

export async function deletePageCallable(target: BrowserTarget, callableId: string): Promise<BrowserPageCallable[]> {
  const resolved = await resolveDocumentTarget(target);
  const result = await callPageController(resolved, 'callable.delete', { callableId });
  if (!Array.isArray(result)) return [];
  return result.map((item) => normalizeCallable(item, resolved))
    .filter((item): item is BrowserPageCallable => Boolean(item));
}

export async function executePageTransformDirection(
  target: BrowserTarget,
  profileId: string,
  directionName: BrowserTransformDirectionName,
  direction: BrowserTransformDirection,
  packet: BrowserTransformPacket,
): Promise<BrowserTransformExecution> {
  const resolved = await resolveDocumentTarget(target);
  const result = await callPageController(resolved, 'transform.execute', {
    profileId, directionName, direction, packet,
  }) as {
    ok?: unknown;
    value?: BrowserTransformExecution;
    error?: { code?: unknown; message?: unknown };
  } | undefined;
  if (!result?.ok) {
    throw new ExtensionError(
      typeof result?.error?.code === 'string' ? result.error.code : 'transform_page_execution_failed',
      typeof result?.error?.message === 'string' ? result.error.message : '页面没有返回有效的 Pipeline 结果',
    );
  }
  if (!result.value || result.value.profileId !== profileId || result.value.direction !== directionName) {
    throw new ExtensionError('transform_invalid_result', '页面没有返回有效的 Pipeline 结果');
  }
  return result.value;
}

export { normalizeCallable };
