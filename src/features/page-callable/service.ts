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
  if (!request || typeof request.method !== 'string' || typeof request.url !== 'string'
    || !Array.isArray(request.expectedDestinations) || request.expectedDestinations.length === 0
    || request.expectedDestinations.some((item) => typeof item !== 'string' || !item.trim())) return undefined;
  const boundaries = Array.isArray(input.boundaries)
    ? input.boundaries.filter((item): item is NonNullable<BrowserPageCallable['transaction']>['boundaries'][number] => (
      ['fetch', 'xhr', 'beacon', 'form'].includes(String(item))
    )).slice(0, 4)
    : ['fetch', 'xhr', 'beacon', 'form'] as NonNullable<BrowserPageCallable['transaction']>['boundaries'];
  if (!boundaries.length) return undefined;
  return {
    request: {
      method: request.method.toUpperCase().slice(0, 16),
      url: request.url.slice(0, 4_096),
      expectedDestinations: request.expectedDestinations.slice(0, 64).map((item) => item.slice(0, 512)),
    },
    inputMode: 'auto',
    boundaries,
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
