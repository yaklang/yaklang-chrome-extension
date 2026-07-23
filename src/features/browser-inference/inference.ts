import type {
  BrowserProfileInferenceCandidate,
  BrowserProfileInferenceEvidence,
  BrowserProfileInferenceMissingStep,
  BrowserProfileInferenceSerialization,
  BrowserRecordingEvent,
  BrowserRecordingLink,
  BrowserTarget,
} from '@/types/models';
import { cryptoEventLabel, isForwardCryptoEvent } from '@/features/browser-crypto/model';
import { inferBusinessFrameHints } from './stack-hints';

const MAX_LINK_DEPTH = 8;
const MAX_CANDIDATES = 16;

export interface BrowserProfileInferenceInput {
  target: BrowserTarget;
  events: BrowserRecordingEvent[];
  links: BrowserRecordingLink[];
}

interface LinkedSource {
  event: BrowserRecordingEvent;
  links: BrowserRecordingLink[];
  stateLinks: BrowserRecordingLink[];
  stateEvents: BrowserRecordingEvent[];
  inputLinks: BrowserRecordingLink[];
  inputEvents: BrowserRecordingEvent[];
}

function isRequestEvent(event: BrowserRecordingEvent): boolean {
  return ['fetch', 'xhr', 'form', 'beacon'].includes(event.kind) && event.operation === 'request';
}

function isCandidateSource(event: BrowserRecordingEvent): boolean {
  return isForwardCryptoEvent(event);
}

function requestMapping(path?: string): { destination?: string; serialization?: BrowserProfileInferenceSerialization } {
  if (!path) return {};
  if (path === '$body' || path === '$body:json') return { destination: 'body', serialization: 'raw-body' };
  if (path.startsWith('$body:json.')) {
    return { destination: `body.${path.slice('$body:json.'.length)}`, serialization: 'json-field' };
  }
  if (path.startsWith('$body:form.')) {
    return { destination: `body.${path.slice('$body:form.'.length)}`, serialization: 'form-field' };
  }
  if (path.startsWith('$body.')) return { destination: `body.${path.slice('$body.'.length)}`, serialization: 'json-field' };
  if (path.startsWith('$headers.')) return { destination: `header.${path.slice('$headers.'.length)}`, serialization: 'header' };
  if (path.startsWith('$query.')) return { destination: `query.${path.slice('$query.'.length)}`, serialization: 'query' };
  return {};
}

function requestLabel(event: BrowserRecordingEvent): string {
  const method = event.method || 'GET';
  if (!event.url) return method;
  try {
    return `${method} ${new URL(event.url, 'https://recording.invalid').pathname || '/'}`;
  } catch {
    return `${method} ${event.url}`;
  }
}

function safeUrlMetadata(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value, 'https://recording.invalid');
    const relative = !/^[a-z][a-z\d+.-]*:\/\//i.test(value);
    const queryKeys = [...new Set([...parsed.searchParams.keys()])].sort();
    const query = queryKeys.length ? `?${queryKeys.map(encodeURIComponent).join('&')}` : '';
    return relative ? `${parsed.pathname}${query}` : `${parsed.origin}${parsed.pathname}${query}`;
  } catch {
    return value.split(/[?#]/, 1)[0].slice(0, 2_048);
  }
}

function sourceLabel(event: BrowserRecordingEvent): string {
  return event.kind === 'crypto' ? cryptoEventLabel(event) : event.operation;
}

function linkedSources(
  request: BrowserRecordingEvent,
  eventsById: Map<string, BrowserRecordingEvent>,
  incoming: Map<string, BrowserRecordingLink[]>,
): LinkedSource[] {
  const output = new Map<string, LinkedSource>();
  const queue: Array<{ eventId: string; links: BrowserRecordingLink[]; depth: number }> = [
    { eventId: request.id, links: [], depth: 0 },
  ];
  const visitedDepth = new Map<string, number>([[request.id, 0]]);
  while (queue.length) {
    const current = queue.shift()!;
    if (current.depth >= MAX_LINK_DEPTH) continue;
    for (const link of incoming.get(current.eventId) || []) {
      if (link.kind === 'state') continue;
      const source = eventsById.get(link.fromEventId);
      if (!source || source.traceId !== request.traceId || source.sequence >= request.sequence) continue;
      const chain = [link, ...current.links];
      if (isCandidateSource(source)) {
        const previous = output.get(source.id);
        if (!previous || chain.length < previous.links.length) {
          output.set(source.id, {
            event: source,
            links: chain,
            ...stateSequence(source, eventsById, incoming),
            ...inputLineage(source, eventsById, incoming),
          });
        }
      }
      const depth = current.depth + 1;
      if ((visitedDepth.get(source.id) ?? Number.POSITIVE_INFINITY) <= depth) continue;
      visitedDepth.set(source.id, depth);
      queue.push({ eventId: source.id, links: chain, depth });
    }
  }
  return [...output.values()];
}

function inputLineage(
  event: BrowserRecordingEvent,
  eventsById: Map<string, BrowserRecordingEvent>,
  incoming: Map<string, BrowserRecordingLink[]>,
): Pick<LinkedSource, 'inputLinks' | 'inputEvents'> {
  const linksById = new Map<string, BrowserRecordingLink>();
  const events = new Map<string, BrowserRecordingEvent>();
  const queue: Array<{ event: BrowserRecordingEvent; depth: number }> = [{ event, depth: 0 }];
  const visited = new Set<string>([event.id]);
  while (queue.length) {
    const current = queue.shift()!;
    if (current.depth >= MAX_LINK_DEPTH) continue;
    for (const link of incoming.get(current.event.id) || []) {
      if (link.kind !== 'value' || link.confidence !== 'exact') continue;
      const source = eventsById.get(link.fromEventId);
      if (!source || source.traceId !== event.traceId || source.kind !== 'transform' || visited.has(source.id)) continue;
      visited.add(source.id);
      linksById.set(link.id, link);
      events.set(source.id, source);
      queue.push({ event: source, depth: current.depth + 1 });
    }
  }
  return {
    inputLinks: [...linksById.values()].sort((left, right) => (
      (eventsById.get(left.fromEventId)?.sequence || 0) - (eventsById.get(right.fromEventId)?.sequence || 0)
    )),
    inputEvents: [...events.values()].sort((left, right) => left.sequence - right.sequence),
  };
}

function stateSequence(
  event: BrowserRecordingEvent,
  eventsById: Map<string, BrowserRecordingEvent>,
  incoming: Map<string, BrowserRecordingLink[]>,
): Pick<LinkedSource, 'stateLinks' | 'stateEvents'> {
  const links: BrowserRecordingLink[] = [];
  const events: BrowserRecordingEvent[] = [event];
  const visited = new Set<string>([event.id]);
  let current = event;
  while (links.length < MAX_LINK_DEPTH) {
    const link = (incoming.get(current.id) || [])
      .filter((item) => item.kind === 'state')
      .sort((left, right) => {
        const leftSequence = eventsById.get(left.fromEventId)?.sequence ?? -1;
        const rightSequence = eventsById.get(right.fromEventId)?.sequence ?? -1;
        return rightSequence - leftSequence;
      })[0];
    if (!link) break;
    const source = eventsById.get(link.fromEventId);
    if (!source || source.traceId !== event.traceId || visited.has(source.id)) break;
    visited.add(source.id);
    links.unshift(link);
    events.unshift(source);
    current = source;
  }
  return { stateLinks: links, stateEvents: events };
}

function temporalSource(
  request: BrowserRecordingEvent,
  events: BrowserRecordingEvent[],
  eventsById: Map<string, BrowserRecordingEvent>,
  incoming: Map<string, BrowserRecordingLink[]>,
): LinkedSource | undefined {
  const source = events
    .filter((event) => event.traceId === request.traceId && event.sequence < request.sequence && isCandidateSource(event))
    .sort((left, right) => right.sequence - left.sequence)[0];
  return source ? {
    event: source,
    links: [],
    ...stateSequence(source, eventsById, incoming),
    ...inputLineage(source, eventsById, incoming),
  } : undefined;
}

function confidenceLevel(score: number): 'high' | 'medium' | 'low' {
  if (score >= 80) return 'high';
  if (score >= 55) return 'medium';
  return 'low';
}

function capturePlan(
  matcherEventId: string,
  events: BrowserRecordingEvent[],
  expectedDestinations: Array<string | undefined>,
) {
  return {
    matcherEventId,
    frameHints: inferBusinessFrameHints(events),
    expectedDestinations: expectedDestinations.filter((item): item is string => Boolean(item)),
    sourceCount: events.length,
  };
}

function buildCandidate(
  target: BrowserTarget,
  request: BrowserRecordingEvent,
  source: LinkedSource,
): BrowserProfileInferenceCandidate {
  const exact = source.links.length > 0 && source.links.every((link) => link.confidence === 'exact');
  const finalLink = source.links.at(-1);
  const { destination, serialization } = requestMapping(finalLink?.toPath);
  const hasCallable = Boolean(source.event.callHandleId && source.event.callableCapable);
  const replayReady = hasCallable && Boolean(destination) && source.links.length === 1;
  const argumentRoles = source.event.arguments || [];
  const evidence: BrowserProfileInferenceEvidence[] = [{
    id: `evidence-request-${request.id}`,
    kind: 'request-boundary',
    strength: 'proven',
    label: `请求边界：${requestLabel(request)}`,
    eventIds: [request.id],
    toPath: finalLink?.toPath,
  }];
  source.links.forEach((link, index) => evidence.push({
    id: `evidence-link-${link.id || `${source.event.id}-${request.id}-${index}`}`,
    kind: link.confidence === 'exact' ? 'exact-value' : 'message-boundary',
    strength: link.confidence === 'exact' ? 'proven' : 'supported',
    label: link.confidence === 'correlated'
      ? '同一 Worker / MessagePort 通道的发送与接收已关联'
      : index === source.links.length - 1 && destination
        ? `输出指纹精确进入 ${destination}`
        : `中间值指纹精确匹配 ${link.fromPath} -> ${link.toPath}`,
    eventIds: [link.fromEventId, link.toEventId],
    fromPath: link.fromPath,
    toPath: link.toPath,
  }));
  if (source.stateLinks.length) {
    const phases = source.stateEvents
      .map((event) => event.crypto?.state?.phase)
      .filter((phase): phase is NonNullable<NonNullable<BrowserRecordingEvent['crypto']>['state']>['phase'] => Boolean(phase));
    evidence.push({
      id: `evidence-state-${source.event.id}`,
      kind: 'state-sequence',
      strength: 'supported',
      label: `同一密码会话已关联 ${phases.join(' -> ') || `${source.stateEvents.length} 个阶段`}`,
      eventIds: source.stateEvents.map((event) => event.id),
      fromPath: source.stateLinks[0]?.fromPath,
      toPath: source.stateLinks.at(-1)?.toPath,
    });
  }
  source.inputLinks.forEach((link, index) => {
    const transform = source.inputEvents.find((event) => event.id === link.fromEventId);
    const category = transform?.transform?.category;
    const label = category === 'canonicalization'
      ? `已关联规范化步骤 ${transform?.operation || link.fromPath} 与密码调用输入`
      : category === 'request-builder'
        ? `已关联请求准备步骤 ${transform?.operation || link.fromPath} 与密码调用输入`
        : `已关联序列化步骤 ${transform?.operation || link.fromPath} 与密码调用输入`;
    evidence.push({
      id: `evidence-input-transform-${link.id || `${source.event.id}-${index}`}`,
      kind: 'transform-lineage',
      strength: 'proven',
      label,
      eventIds: [link.fromEventId, link.toEventId],
      fromPath: link.fromPath,
      toPath: link.toPath,
    });
  });
  evidence.push({
    id: `evidence-order-${source.event.id}-${request.id}`,
    kind: 'trace-order',
    strength: 'supported',
    label: '加密调用与请求位于同一业务 Trace，且调用发生在请求之前',
    eventIds: [source.event.id, request.id],
  });
  if (hasCallable) evidence.push({
    id: `evidence-callable-${source.event.id}`,
    kind: 'callable',
    strength: 'proven',
    label: '页面仍保留本次调用的原函数、receiver 与固定参数模板',
    eventIds: [source.event.id],
  });

  let score = 20;
  if (exact) score += 40;
  if (destination) score += 10;
  if (hasCallable) score += 15;
  if (argumentRoles.length) score += 10;
  score += 5;
  score = Math.min(100, score);

  const missing: BrowserProfileInferenceMissingStep[] = [];
  let status: BrowserProfileInferenceCandidate['status'];
  if (!exact || !destination) {
    status = 'capture-required';
    missing.push({
      kind: 'business-callable',
      label: source.links.some((link) => link.confidence === 'correlated')
        ? '已关联页面与 Worker 消息链；继续捕获请求前的上层业务函数，即可保留 Worker 内部状态与完整报文封装'
        : '字段级值链尚不完整；继续捕获请求前的上层业务函数，不需要重新录制更长的操作',
      action: 'capture-business-function',
    });
  } else if (replayReady) {
    status = 'ready';
  } else if (source.event.kind === 'crypto') {
    status = 'capture-required';
    missing.push({
      kind: 'business-callable',
      label: '已定位低层加密调用；还需捕获上层业务函数，才能保留序列化、动态参数与完整报文封装',
      action: 'capture-business-function',
    });
  } else {
    status = 'mapping-required';
    missing.push({
      kind: 'input-mapping',
      label: '需要确认明文输入在逻辑请求中的来源',
      action: 'select-input',
    });
  }

  const candidateId = `candidate-${source.event.id}-${request.id}`;
  const sourceName = sourceLabel(source.event);
  const requestName = requestLabel(request);
  const requiredDecision = status === 'capture-required' ? 'capture-business-callable'
    : status === 'mapping-required' ? 'map-input'
      : status === 'ready' ? 'map-input'
        : destination ? 'map-input' : 'map-output';
  return {
    id: candidateId,
    recordingId: request.recordingId,
    traceId: request.traceId,
    target: { ...target },
    direction: 'request',
    request: {
      eventId: request.id,
      method: request.method || 'GET',
      url: request.url || '',
      destination,
      serialization,
      mappings: [{ sourceEventId: source.event.id, destination, serialization }],
    },
    source: {
      eventId: source.event.id,
      kind: source.event.kind,
      operation: source.event.operation,
      crypto: source.event.crypto,
      callHandleId: source.event.callHandleId,
      arguments: argumentRoles,
      destination,
      serialization,
    },
    sources: [{
      eventId: source.event.id,
      kind: source.event.kind,
      operation: source.event.operation,
      crypto: source.event.crypto,
      callHandleId: source.event.callHandleId,
      arguments: argumentRoles,
      destination,
      serialization,
    }],
    status,
    confidence: { score, level: confidenceLevel(score) },
    summary: replayReady
      ? `已确认 ${sourceName} 的输出进入 ${destination}，可生成明文网关`
      : exact && destination
        ? `已确认 ${sourceName} 的输出进入 ${destination}`
      : `已定位 ${sourceName} 与 ${requestName}，可继续捕获完整页面业务封装`,
    flow: [
      '明文输入（待确认）',
      ...(source.inputEvents.length ? [`${source.inputEvents.length} 个输入准备步骤`] : []),
      sourceName,
      ...(source.links.length > 1 ? [`${source.links.length - 1} 个中间转换`] : []),
      destination ? `${requestName} · ${destination}` : requestName,
    ],
    pipeline: [
      { id: `${candidateId}-input`, kind: 'context.read', label: '读取明文输入', source: '待确认' },
      {
        id: `${candidateId}-call`,
        kind: 'page.call',
        label: sourceName,
        callHandleId: source.event.callHandleId,
      },
      {
        id: `${candidateId}-output`,
        kind: 'output.write',
        label: destination ? `写入 ${destination}` : '确认请求输出位置',
        destination,
      },
    ],
    evidence,
    missing,
    capturePlan: status === 'capture-required'
      ? capturePlan(
        source.event.id,
        [...new Map([...source.inputEvents, ...source.stateEvents].map((event) => [event.id, event])).values()],
        [destination],
      )
      : undefined,
    aiContext: {
      valuePolicy: 'metadata-only',
      request: {
        eventId: request.id,
        method: request.method || 'GET',
        url: safeUrlMetadata(request.url) || '',
        destination,
        serialization,
      },
      source: {
        eventId: source.event.id,
        kind: source.event.kind,
        operation: source.event.operation,
        crypto: source.event.crypto,
        scriptUrl: safeUrlMetadata(source.event.scriptUrl),
        arguments: argumentRoles,
      },
      sources: [{
        eventId: source.event.id,
        operation: source.event.operation,
        crypto: source.event.crypto,
        destination,
      }],
      evidenceIds: evidence.map((item) => item.id),
      requiredDecision,
    },
  };
}

function buildUnknownBoundaryCandidate(
  target: BrowserTarget,
  request: BrowserRecordingEvent,
): BrowserProfileInferenceCandidate {
  const requestName = requestLabel(request);
  const candidateId = `candidate-boundary-${request.id}`;
  const stackAvailable = Boolean(request.stack || request.scriptUrl);
  const evidence: BrowserProfileInferenceEvidence[] = [{
    id: `evidence-request-${request.id}`,
    kind: 'request-boundary',
    strength: 'proven',
    label: `真实请求边界：${requestName}`,
    eventIds: [request.id],
  }];
  if (stackAvailable) evidence.push({
    id: `evidence-stack-${request.id}`,
    kind: 'heuristic',
    strength: 'supported',
    label: '请求发生时保留了有界页面调用来源，可直接进入业务函数捕获',
    eventIds: [request.id],
  });
  const source = {
    eventId: request.id,
    kind: request.kind,
    operation: 'unknown-business-envelope',
    arguments: [],
  };
  const score = stackAvailable ? 45 : 35;
  return {
    id: candidateId,
    recordingId: request.recordingId,
    traceId: request.traceId,
    target: { ...target },
    direction: 'request',
    request: {
      eventId: request.id,
      method: request.method || 'GET',
      url: request.url || '',
      mappings: [],
    },
    source,
    sources: [source],
    status: 'capture-required',
    confidence: { score, level: confidenceLevel(score) },
    summary: `已定位 ${requestName} 的真实发送边界；算法或库未知不影响继续捕获`,
    flow: ['明文输入（待定位）', '页面业务封装（待捕获）', requestName],
    pipeline: [
      { id: `${candidateId}-input`, kind: 'context.read', label: '读取明文输入', source: '由业务函数参数确认' },
      { id: `${candidateId}-call`, kind: 'page.call', label: '页面业务封装' },
      { id: `${candidateId}-output`, kind: 'output.write', label: '写入真实请求' },
    ],
    evidence,
    missing: [{
      kind: 'business-callable',
      label: '没有发现可见的已知密码库调用；重复一次当前操作，插件会在真实请求边界暂停并推荐上层页面函数',
      action: 'capture-business-function',
    }],
    capturePlan: capturePlan(request.id, [request], []),
    aiContext: {
      valuePolicy: 'metadata-only',
      request: {
        eventId: request.id,
        method: request.method || 'GET',
        url: safeUrlMetadata(request.url) || '',
      },
      source: {
        eventId: request.id,
        kind: request.kind,
        operation: 'unknown-business-envelope',
        scriptUrl: safeUrlMetadata(request.scriptUrl),
        arguments: [],
      },
      sources: [{ eventId: request.id, operation: 'unknown-business-envelope' }],
      evidenceIds: evidence.map((item) => item.id),
      requiredDecision: 'capture-business-callable',
    },
  };
}

function buildRequestGraphCandidate(
  target: BrowserTarget,
  request: BrowserRecordingEvent,
  sources: LinkedSource[],
): BrowserProfileInferenceCandidate {
  if (sources.length === 1) return buildCandidate(target, request, sources[0]);
  const members = [...sources]
    .sort((left, right) => left.event.sequence - right.event.sequence || left.event.id.localeCompare(right.event.id))
    .map((source) => buildCandidate(target, request, source));
  const primary = members[0];
  const graphSources = members.map((member) => member.source);
  const mappings = graphSources.map((source) => ({
    sourceEventId: source.eventId,
    destination: source.destination,
    serialization: source.serialization,
  }));
  const evidenceById = new Map<string, BrowserProfileInferenceEvidence>();
  for (const member of members) {
    for (const item of member.evidence) evidenceById.set(item.id, item);
  }
  const evidence = [...evidenceById.values()];
  const allMapped = graphSources.every((source) => Boolean(source.destination));
  const score = Math.max(0, Math.min(90, Math.min(...members.map((member) => member.confidence.score)) - 10));
  const requestName = requestLabel(request);
  const destinations = graphSources.map((source) => source.destination).filter((item): item is string => Boolean(item));
  const candidateId = `candidate-graph-${request.id}-${graphSources.map((source) => source.eventId).join('-')}`;
  const missing: BrowserProfileInferenceMissingStep[] = [{
    kind: 'business-callable',
    label: '同一请求包含多个相关密码调用；需要捕获上层业务封装，才能保持随机 Key、IV、Nonce 与各输出字段在每次回放中一致',
    action: 'capture-business-function',
  }];
  return {
    id: candidateId,
    recordingId: request.recordingId,
    traceId: request.traceId,
    target: { ...target },
    direction: 'request',
    request: {
      eventId: request.id,
      method: request.method || 'GET',
      url: request.url || '',
      mappings,
    },
    source: primary.source,
    sources: graphSources,
    status: 'capture-required',
    confidence: { score, level: confidenceLevel(score) },
    summary: allMapped
      ? `已确认 ${graphSources.length} 个密码调用分别进入 ${destinations.join('、')}，需要保留它们的动态值关系`
      : `已识别 ${graphSources.length} 个密码调用与 ${requestName} 的请求级数据流`,
    flow: [
      '明文与动态参数',
      `${graphSources.length} 个关联密码调用`,
      allMapped ? `${requestName} · ${destinations.length} 个字段` : requestName,
    ],
    pipeline: graphSources.flatMap((source, index) => [
      { id: `${candidateId}-input-${index}`, kind: 'context.read' as const, label: `读取调用 ${index + 1} 输入`, source: '待由业务封装确认' },
      { id: `${candidateId}-call-${index}`, kind: 'page.call' as const, label: source.crypto ? source.crypto.operation : source.operation, callHandleId: source.callHandleId },
      { id: `${candidateId}-output-${index}`, kind: 'output.write' as const, label: source.destination ? `写入 ${source.destination}` : '确认输出位置', destination: source.destination },
    ]),
    evidence,
    missing,
    capturePlan: capturePlan(
      primary.source.eventId,
      [...new Map(sources.flatMap((source) => [...source.inputEvents, ...source.stateEvents]).map((event) => [event.id, event])).values()],
      destinations,
    ),
    aiContext: {
      valuePolicy: 'metadata-only',
      request: {
        eventId: request.id,
        method: request.method || 'GET',
        url: safeUrlMetadata(request.url) || '',
      },
      source: primary.aiContext.source,
      sources: graphSources.map((source) => ({
        eventId: source.eventId,
        operation: source.operation,
        crypto: source.crypto,
        destination: source.destination,
      })),
      evidenceIds: evidence.map((item) => item.id),
      requiredDecision: 'capture-business-callable',
    },
  };
}

export function inferBrowserTransformProfiles(input: BrowserProfileInferenceInput): BrowserProfileInferenceCandidate[] {
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const incoming = new Map<string, BrowserRecordingLink[]>();
  for (const link of input.links) incoming.set(link.toEventId, [...(incoming.get(link.toEventId) || []), link]);
  const output: BrowserProfileInferenceCandidate[] = [];
  for (const request of events.filter(isRequestEvent)) {
    const exactSources = linkedSources(request, eventsById, incoming);
    const sources = exactSources.length
      ? exactSources
      : [temporalSource(request, events, eventsById, incoming)].filter((item): item is LinkedSource => Boolean(item));
    output.push(sources.length
      ? buildRequestGraphCandidate(input.target, request, sources)
      : buildUnknownBoundaryCandidate(input.target, request));
  }
  return output
    .sort((left, right) => right.confidence.score - left.confidence.score
      || left.source.eventId.localeCompare(right.source.eventId))
    .slice(0, MAX_CANDIDATES);
}
