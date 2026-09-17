import type { BrowserProfileInferenceCandidate, BrowserRecordingEvent } from '@/types/models';

export type RecordingEventDirection = 'request' | 'response';

const HTTP_EVENT_KINDS = new Set<BrowserRecordingEvent['kind']>(['fetch', 'xhr', 'form', 'beacon']);

export function recordingEventDirection(
  event: BrowserRecordingEvent,
  candidates: BrowserProfileInferenceCandidate[],
): RecordingEventDirection | undefined {
  if (HTTP_EVENT_KINDS.has(event.kind)) {
    return event.operation === 'response' || event.operation.startsWith('response.')
      ? 'response'
      : 'request';
  }
  const directions = new Set(candidates.filter((candidate) => (
    candidate.source.eventId === event.id
    || candidate.sources.some((source) => source.eventId === event.id)
    || candidate.evidence.some((evidence) => evidence.eventIds.includes(event.id))
  )).map((candidate) => candidate.direction));
  return directions.size === 1 ? [...directions][0] : undefined;
}

export type BrowserGatewayNextStep = {
  kind: 'capture' | 'create' | 'blocked';
  candidate: BrowserProfileInferenceCandidate;
  label?: string;
  description: string;
};

const directionName = (direction: BrowserProfileInferenceCandidate['direction']) => (
  direction === 'request' ? '请求' : '响应'
);

export function browserGatewayNextStep(
  candidate: BrowserProfileInferenceCandidate,
  paired?: BrowserProfileInferenceCandidate,
): BrowserGatewayNextStep {
  if (candidate.status !== 'ready') {
    return candidate.status === 'capture-required'
      ? {
        kind: 'capture', candidate, label: `继续捕获${directionName(candidate.direction)}方向`,
        description: `需要先捕获完整的${directionName(candidate.direction)}转换。`,
      }
      : { kind: 'blocked', candidate, description: candidate.missing[0]?.label || '当前转换证据还不完整。' };
  }
  if (!paired) return {
    kind: 'create', candidate, label: `生成仅${directionName(candidate.direction)}网关`,
    description: `当前操作只检测到${directionName(candidate.direction)}转换，将生成单向协议网关。`,
  };
  if (paired.status === 'capture-required') return {
    kind: 'capture', candidate: paired, label: `继续捕获${directionName(paired.direction)}方向`,
    description: `${directionName(candidate.direction)}方向已就绪，还需要捕获${directionName(paired.direction)}方向。`,
  };
  if (paired.status !== 'ready') return {
    kind: 'blocked', candidate: paired,
    description: paired.missing[0]?.label || `${directionName(paired.direction)}转换证据还不完整。`,
  };
  return {
    kind: 'create', candidate, label: '生成双向协议网关',
    description: '请求和响应转换都已就绪，将合并为一个双向协议网关。',
  };
}
