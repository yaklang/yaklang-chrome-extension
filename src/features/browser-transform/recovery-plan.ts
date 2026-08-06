import type {
  BrowserPageCallable,
  BrowserPageCallableBodyFormat,
  BrowserTarget,
  BrowserTransformDirection,
  BrowserTransformDirectionName,
  BrowserTransformProfile,
  BrowserTransformRecoveryBinding,
  BrowserTransformRecoveryCapturePlan,
  BrowserTransformRecoveryGuide,
  BrowserTransformRecoveryPlan,
} from '@/types/models';
import { BROWSER_TRANSFORM_RECOVERY_CONTRACT_VERSION } from '@/types/models';
import { compileGuidedTransform, parseGuidedTransform } from './guided';

const RECOVERY_REASON = {
  multipleCallables: '当前网关引用了多个页面函数，自动恢复不能证明它们在新文档中的对应关系',
  advancedPipeline: '当前网关使用高级 Pipeline，自动恢复不会猜测新的页面函数映射',
  responseOnly: '当前网关只处理响应；请求边界无法证明响应解密函数的对应关系',
  unsupportedDestination: '当前网关写入 Header 或 Query，请求事务暂时不能恢复这类输出',
  routeUnavailable: '当前网关没有可用于一次性请求断点的精确路由',
} as const;

export const BROWSER_TRANSFORM_RECOVERY_MAX_BYTES = 64 * 1_024;
const SENSITIVE_QUERY_NAME = /(token|secret|pass(word|wd)?|session|authorization|auth|api[-_]?key|signature|credential|code)/i;

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function decodedQueryName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sanitizedURL(
  value: string,
  base?: string,
  preserveSafeQuery = true,
): { url: string; sensitiveQuery: boolean } | undefined {
  try {
    const parsed = new URL(value, base);
    const sensitiveQuery = [...parsed.searchParams.keys()].some((name) => SENSITIVE_QUERY_NAME.test(name));
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    if (!preserveSafeQuery || sensitiveQuery) parsed.search = '';
    return { url: parsed.toString(), sensitiveQuery };
  } catch {
    const withoutFragment = value.split('#', 1)[0] || '';
    const [path, query = ''] = withoutFragment.split('?', 2);
    const sensitiveQuery = query
      .split('&')
      .map((entry) => entry.split('=', 1)[0] || '')
      .some((name) => SENSITIVE_QUERY_NAME.test(decodedQueryName(name)));
    return path ? {
      url: preserveSafeQuery && query && !sensitiveQuery ? `${path}?${query}` : path,
      sensitiveQuery,
    } : undefined;
  }
}

function pageCallNodes(
  profile: Pick<BrowserTransformProfile, 'request' | 'response'>,
): Array<{ direction: BrowserTransformDirectionName; nodeId: string; callableId: string }> {
  return (['request', 'response'] as const).flatMap((direction) => (
    profile[direction].enabled
      ? profile[direction].nodes
        .filter((node): node is Extract<BrowserTransformDirection['nodes'][number], { kind: 'page.call' }> => node.kind === 'page.call')
        .map((node) => ({ direction, nodeId: node.id, callableId: node.callableId }))
      : []
  ));
}

function exactRoute(profile: Pick<BrowserTransformProfile, 'origin' | 'match'>, transactionUrl?: string): {
  url: string;
  urlPattern: string;
} | undefined {
  if (transactionUrl) {
    const sanitized = sanitizedURL(transactionUrl, profile.origin);
    if (!sanitized || sanitized.sensitiveQuery) return undefined;
    const parsed = new URL(sanitized.url);
    return { url: parsed.toString(), urlPattern: `${parsed.pathname}${parsed.search}` };
  }
  const route = profile.match.urlPattern.trim().replace(/^\*+/, '');
  if (!route || route.includes('*')) return undefined;
  try {
    const sanitized = sanitizedURL(route, `${profile.origin}/`);
    if (!sanitized || sanitized.sensitiveQuery) return undefined;
    const parsed = new URL(sanitized.url);
    return { url: parsed.toString(), urlPattern: `${parsed.pathname}${parsed.search}` };
  } catch {
    return undefined;
  }
}

function contentType(direction: BrowserTransformDirection): string {
  const literals = new Map(direction.nodes
    .filter((node): node is Extract<BrowserTransformDirection['nodes'][number], { kind: 'builtin' }> => (
      node.kind === 'builtin' && node.operation === 'value.literal'
    ))
    .map((node) => [node.id, typeof node.options?.value === 'string' ? node.options.value.toLowerCase() : '']));
  const header = direction.nodes.find((node) => (
    node.kind === 'output.write'
    && node.destination.toLowerCase() === 'header.content-type'
    && literals.has(node.source.nodeId)
  ));
  return header?.kind === 'output.write' ? literals.get(header.source.nodeId) || '' : '';
}

function bodyFormat(
  profile: Pick<BrowserTransformProfile, 'request'>,
  callable: BrowserPageCallable,
  guides: BrowserTransformRecoveryGuide[],
): BrowserPageCallableBodyFormat {
  if (callable.transaction) return callable.transaction.request.bodyFormat;
  const requestGuides = guides.filter((guide) => guide.direction === 'request');
  if (requestGuides.some((guide) => guide.outputKind === 'form-field')) return 'form';
  if (requestGuides.some((guide) => guide.outputKind === 'json-field')) return 'json';
  const type = contentType(profile.request);
  if (type.includes('application/x-www-form-urlencoded')) return 'form';
  if (type.includes('application/json')) return 'json';
  const bodyOutput = profile.request.nodes.find((node) => node.kind === 'output.write' && node.destination === 'body');
  return bodyOutput?.kind === 'output.write' && bodyOutput.encoding === 'json' ? 'json' : 'raw';
}

function expectedDestinations(
  callable: BrowserPageCallable,
  guides: BrowserTransformRecoveryGuide[],
): string[] {
  if (callable.transaction) return unique(callable.transaction.request.expectedDestinations);
  return unique(guides
    .filter((guide) => guide.direction === 'request')
    .flatMap((guide) => {
      if (guide.outputKind === 'body') return ['body'];
      if (guide.outputKind === 'json-field' || guide.outputKind === 'form-field') {
        return guide.outputField.trim() ? [`body.${guide.outputField.trim()}`] : [];
      }
      return [];
    }));
}

function frameHints(callable: BrowserPageCallable) {
  const functionName = callable.provenance.functionName || callable.operation || callable.name;
  const hints = [...(callable.provenance.businessFrameHints || []), ...(functionName ? [{
    functionName: functionName.slice(0, 240),
    url: callable.provenance.sourceUrl?.slice(0, 4_096),
    support: 1,
    averageDepth: 0,
  }] : [])];
  return hints
    .filter((hint, index) => hints.findIndex((item) => (
      item.functionName === hint.functionName && item.url === hint.url
    )) === index)
    .slice(0, 16)
    .map((hint) => ({
      ...hint,
      url: hint.url ? sanitizedURL(hint.url, undefined, false)?.url.slice(0, 1_024) : undefined,
    }));
}

function recoveryTransaction(callable: BrowserPageCallable): BrowserPageCallable['transaction'] {
  if (!callable.transaction) return undefined;
  const transaction = structuredClone(callable.transaction);
  const url = sanitizedURL(transaction.request.url, callable.origin)?.url || '';
  return {
    version: 2,
    prerequisites: transaction.prerequisites.map((step) => ({
      ...step,
      url: sanitizedURL(step.url, callable.origin)?.url || '',
      response: {
        ...step.response,
        url: sanitizedURL(step.response.url, callable.origin)?.url || '',
      },
    })),
    request: {
      ...transaction.request,
      url,
    },
    inputMode: transaction.inputMode,
  };
}

function recoveryGuides(
  profile: Pick<BrowserTransformProfile, 'request' | 'response'>,
  callable: BrowserPageCallable,
): BrowserTransformRecoveryGuide[] {
  return (['request', 'response'] as const).flatMap((direction) => {
    if (!profile[direction].enabled) return [];
    const guide = parseGuidedTransform(profile[direction], [callable]);
    return guide ? [{
      direction,
      callableId: guide.callableId,
      inputPaths: [...guide.inputPaths],
      resultPath: guide.resultPath,
      outputKind: guide.outputKind,
      outputField: guide.outputField,
      setFormContentType: guide.setFormContentType,
    }] : [];
  });
}

function capturePlan(
  profile: BrowserTransformProfile,
  callable: BrowserPageCallable,
  binding: BrowserTransformRecoveryBinding,
  uniqueCallableCount: number,
): BrowserTransformRecoveryCapturePlan {
  const route = exactRoute(profile, callable.transaction?.request.url);
  const requestGuides = binding.guides.filter((guide) => guide.direction === 'request');
  const unsupportedDestination = requestGuides.some((guide) => guide.outputKind === 'header' || guide.outputKind === 'query');
  let reason: string | undefined;
  if (uniqueCallableCount !== 1) reason = RECOVERY_REASON.multipleCallables;
  else if (!binding.nodeIds.some((item) => item.direction === 'request')) reason = RECOVERY_REASON.responseOnly;
  else if (!requestGuides.length) reason = RECOVERY_REASON.advancedPipeline;
  else if (unsupportedDestination) reason = RECOVERY_REASON.unsupportedDestination;
  else if (!route) reason = RECOVERY_REASON.routeUnavailable;
  const destinations = expectedDestinations(callable, binding.guides);
  if (!reason && destinations.length === 0) reason = RECOVERY_REASON.unsupportedDestination;
  return {
    kind: 'request',
    method: callable.transaction?.request.method || profile.match.methods[0] || 'POST',
    url: route?.url || '',
    urlPattern: route?.urlPattern || '',
    expectedDestinations: destinations,
    bodyFormat: bodyFormat(profile, callable, binding.guides),
    frameHints: binding.frameHints,
    automatic: !reason,
    reason,
  };
}

export function createBrowserTransformRecoveryPlan(
  profile: BrowserTransformProfile,
  callables: BrowserPageCallable[],
  now = Date.now(),
): BrowserTransformRecoveryPlan | undefined {
  const nodes = pageCallNodes(profile);
  const callableIds = unique(nodes.map((node) => node.callableId));
  const callable = callables.find((item) => item.id === callableIds[0]);
  if (!callable || callableIds.length === 0) return undefined;
  const guides = recoveryGuides(profile, callable);
  const binding: BrowserTransformRecoveryBinding = {
    callableId: callable.id,
    name: callable.name,
    kind: callable.kind,
    operation: callable.operation,
    nodeIds: nodes
      .filter((node) => node.callableId === callable.id)
      .map(({ direction, nodeId }) => ({ direction, nodeId })),
    inputSemantics: callable.inputSlots.map((slot) => ({
      id: slot.id,
      name: slot.name,
      index: slot.index,
      role: slot.role,
      dataType: slot.dataType,
      required: slot.required,
      retained: slot.retained,
    })),
    output: structuredClone(callable.output),
    guides,
    frameHints: frameHints(callable),
    transaction: recoveryTransaction(callable),
  };
  const recovery: BrowserTransformRecoveryPlan = {
    contractVersion: BROWSER_TRANSFORM_RECOVERY_CONTRACT_VERSION,
    state: 'ready',
    desiredEnabled: profile.enabled,
    boundDocumentId: profile.target.documentId,
    binding,
    capture: capturePlan(profile, callable, binding, callableIds.length),
    createdAt: profile.recovery?.createdAt || now,
    updatedAt: now,
  };
  return new TextEncoder().encode(JSON.stringify(recovery)).byteLength <= BROWSER_TRANSFORM_RECOVERY_MAX_BYTES
    ? recovery
    : undefined;
}

export function staleBrowserTransformProfile(
  profile: BrowserTransformProfile,
  reason: string,
  now = Date.now(),
): BrowserTransformProfile {
  if (!profile.recovery) return profile.enabled ? { ...profile, enabled: false, updatedAt: now } : profile;
  const desiredEnabled = profile.recovery.state === 'ready' ? profile.enabled : profile.recovery.desiredEnabled;
  return {
    ...profile,
    enabled: false,
    recovery: {
      ...profile.recovery,
      state: 'stale',
      desiredEnabled,
      pending: undefined,
      validation: undefined,
      reason,
      updatedAt: now,
    },
    updatedAt: now,
  };
}

function replaceCallableId(
  direction: BrowserTransformDirection,
  previousCallableId: string,
  callableId: string,
): BrowserTransformDirection {
  return {
    ...direction,
    nodes: direction.nodes.map((node) => (
      node.kind === 'page.call' && node.callableId === previousCallableId
        ? { ...node, callableId }
        : structuredClone(node)
    )),
  };
}

export function compileBrowserTransformRecoveryDirections(
  profile: Pick<BrowserTransformProfile, 'request' | 'response'>,
  recovery: BrowserTransformRecoveryPlan,
  callable: BrowserPageCallable,
): { request: BrowserTransformDirection; response: BrowserTransformDirection } {
  const compile = (direction: BrowserTransformDirectionName): BrowserTransformDirection => {
    const current = profile[direction];
    const referencesBinding = current.enabled && current.nodes.some((node) => (
      node.kind === 'page.call' && node.callableId === recovery.binding.callableId
    ));
    if (!referencesBinding) return structuredClone(current);
    const guide = recovery.binding.guides.find((item) => item.direction === direction);
    if (guide) {
      return compileGuidedTransform({
        callableId: callable.id,
        inputPaths: [...guide.inputPaths],
        resultPath: callable.output.shape === 'envelope' ? undefined : guide.resultPath,
        outputKind: guide.outputKind,
        outputField: guide.outputField,
        setFormContentType: guide.setFormContentType,
      }, callable);
    }
    if (callable.output.shape !== recovery.binding.output.shape) {
      throw new Error('重新捕获的页面函数输出契约已经变化，高级 Pipeline 不能自动改写');
    }
    return replaceCallableId(current, recovery.binding.callableId, callable.id);
  };
  return {
    request: compile('request'),
    response: compile('response'),
  };
}

export function recoveryTargetMatches(
  left: BrowserTarget | undefined,
  right: BrowserTarget | undefined,
): boolean {
  return Boolean(left && right
    && left.tabId === right.tabId
    && left.frameId === right.frameId
    && left.documentId
    && left.documentId === right.documentId);
}
