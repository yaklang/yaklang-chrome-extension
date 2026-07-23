import type {
  BrowserRecordingEvent,
  BrowserRecordingLink,
  BrowserRecordingTrace,
  BrowserRecordingValueEvidence,
} from '@/types/models';
import { cryptoEventLabel } from '@/features/browser-crypto/model';

export const MAX_RECORDING_EVENTS = 500;

const NAVIGATION_PHASE_ORDER: Record<NonNullable<BrowserRecordingEvent['navigation']>['phase'], number> = {
  started: 0,
  committed: 1,
  completed: 2,
  restored: 2,
  'same-document': 2,
  failed: 2,
};

function mergeEvidence(
  previous: BrowserRecordingValueEvidence[],
  next: BrowserRecordingValueEvidence[],
): BrowserRecordingValueEvidence[] {
  const previousByIdentity = new Map(previous.map((item) => [`${item.path}\u0000${item.fingerprint}`, item]));
  return next.map((item) => {
    const existing = previousByIdentity.get(`${item.path}\u0000${item.fingerprint}`);
    return existing && item.preview === undefined ? { ...item, preview: existing.preview } : item;
  });
}

function mergeEvent(previous: BrowserRecordingEvent, next: BrowserRecordingEvent): BrowserRecordingEvent {
  const previousNavigation = previous.navigation;
  const nextNavigation = next.navigation;
  const navigation = previousNavigation && nextNavigation
    ? NAVIGATION_PHASE_ORDER[previousNavigation.phase] > NAVIGATION_PHASE_ORDER[nextNavigation.phase]
      ? previousNavigation
      : nextNavigation
    : nextNavigation || previousNavigation;
  return {
    ...previous,
    ...next,
    durationMs: next.durationMs ?? previous.durationMs,
    sensitiveCaptured: previous.sensitiveCaptured || next.sensitiveCaptured,
    inputPreview: next.inputPreview ?? previous.inputPreview,
    outputPreview: next.outputPreview ?? previous.outputPreview,
    inputs: mergeEvidence(previous.inputs, next.inputs),
    outputs: mergeEvidence(previous.outputs, next.outputs),
    navigation,
    error: next.error ?? previous.error,
  };
}

function orderedEvents(events: BrowserRecordingEvent[]): BrowserRecordingEvent[] {
  return [...events].sort((left, right) => (
    left.sequence - right.sequence
    || left.timestamp - right.timestamp
    || left.id.localeCompare(right.id)
  ));
}

export function mergeRecordingEvents(
  collections: BrowserRecordingEvent[][],
  limit = MAX_RECORDING_EVENTS,
): BrowserRecordingEvent[] {
  const byId = new Map<string, BrowserRecordingEvent>();
  for (const events of collections) {
    for (const event of events) {
      const previous = byId.get(event.id);
      byId.set(event.id, previous ? mergeEvent(previous, event) : event);
    }
  }
  return orderedEvents([...byId.values()]).slice(-Math.max(1, limit));
}

export function nextRecordingSequence(events: BrowserRecordingEvent[]): number {
  return events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1;
}

export function latestRecordingTraceId(events: BrowserRecordingEvent[]): string | undefined {
  return orderedEvents(events).at(-1)?.traceId;
}

export function buildRecordingLinks(events: BrowserRecordingEvent[]): BrowserRecordingLink[] {
  const links: BrowserRecordingLink[] = [];
  const outputs = new Map<string, Array<{ eventId: string; path: string; traceId: string }>>();
  for (const event of orderedEvents(events)) {
    for (const input of event.inputs) {
      const candidates = outputs.get(input.fingerprint) || [];
      const source = [...candidates].reverse().find((candidate) => (
        candidate.traceId === event.traceId && candidate.eventId !== event.id
      ));
      if (!source) continue;
      links.push({
        id: `link-${source.eventId}-${event.id}-${links.length}`,
        traceId: event.traceId,
        kind: 'value',
        fromEventId: source.eventId,
        fromPath: source.path,
        toEventId: event.id,
        toPath: input.path,
        confidence: 'exact',
      });
    }
    for (const output of event.outputs) {
      const current = outputs.get(output.fingerprint) || [];
      current.push({ eventId: event.id, path: output.path, traceId: event.traceId });
      outputs.set(output.fingerprint, current.slice(-32));
    }
  }
  const lastStateEvent = new Map<string, BrowserRecordingEvent>();
  for (const event of orderedEvents(events)) {
    const state = event.crypto?.state;
    if (event.kind !== 'crypto' || !state?.correlationId || state.model === 'stateless') continue;
    const key = `${event.traceId}\u0000${event.crypto?.adapterId || ''}\u0000${state.correlationId}`;
    const source = lastStateEvent.get(key);
    if (source && source.id !== event.id) {
      links.push({
        id: `link-state-${source.id}-${event.id}-${links.length}`,
        traceId: event.traceId,
        kind: 'state',
        fromEventId: source.id,
        fromPath: `$state.${source.crypto?.state?.phase || 'unknown'}`,
        toEventId: event.id,
        toPath: `$state.${state.phase || 'unknown'}`,
        confidence: 'correlated',
      });
    }
    lastStateEvent.set(key, event);
  }
  const lastSentByChannel = new Map<string, BrowserRecordingEvent>();
  for (const event of orderedEvents(events)) {
    if (!event.channelId || !['worker', 'message'].includes(event.kind)) continue;
    if (event.direction === 'send') {
      lastSentByChannel.set(event.channelId, event);
      continue;
    }
    if (event.direction !== 'receive') continue;
    const source = lastSentByChannel.get(event.channelId);
    if (!source || source.traceId !== event.traceId) continue;
    links.push({
      id: `link-channel-${source.id}-${event.id}-${links.length}`,
      traceId: event.traceId,
      kind: 'channel',
      fromEventId: source.id,
      fromPath: '$message',
      toEventId: event.id,
      toPath: '$message',
      confidence: 'correlated',
    });
  }
  return links.slice(0, 1_000);
}

function requestPath(url: string): string {
  try { return new URL(url, 'https://recording.invalid').pathname; } catch { return url; }
}

function traceLabel(events: BrowserRecordingEvent[]): string {
  const interaction = events.find((item) => item.kind === 'interaction');
  if (interaction?.label) return interaction.label;
  const request = events.find((item) => ['fetch', 'xhr', 'form', 'beacon'].includes(item.kind));
  if (request?.url) return `${request.method || 'GET'} ${requestPath(request.url)}`;
  const crypto = events.find((item) => item.kind === 'crypto');
  if (crypto) return cryptoEventLabel(crypto);
  const message = events.find((item) => item.kind === 'worker' || item.kind === 'message');
  if (message) return message.kind === 'worker' ? 'Worker 消息' : '页面消息通道';
  const navigation = events.find((item) => item.kind === 'navigation');
  if (navigation?.navigation?.kind === 'back-forward') return '浏览器前进或后退';
  if (navigation?.navigation?.kind === 'history') return '页面路由变化';
  if (navigation?.navigation?.kind === 'fragment') return '页面锚点变化';
  return navigation?.label || '页面后台活动';
}

export function buildRecordingTraces(
  events: BrowserRecordingEvent[],
  links: BrowserRecordingLink[],
): BrowserRecordingTrace[] {
  const groups = new Map<string, BrowserRecordingEvent[]>();
  for (const event of events) groups.set(event.traceId, [...(groups.get(event.traceId) || []), event]);
  return [...groups.entries()].map(([id, traceEvents]) => {
    const sorted = orderedEvents(traceEvents);
    return {
      id,
      interactionId: sorted.find((item) => item.interactionId)?.interactionId,
      label: traceLabel(sorted),
      startedAt: sorted[0]?.timestamp || 0,
      endedAt: sorted.reduce((maximum, item) => Math.max(maximum, item.timestamp + (item.durationMs || 0)), sorted[0]?.timestamp || 0),
      eventIds: sorted.map((item) => item.id),
      requestCount: sorted.filter((item) => ['fetch', 'xhr', 'form', 'beacon'].includes(item.kind)).length,
      cryptoCount: sorted.filter((item) => item.kind === 'crypto').length,
      websocketCount: sorted.filter((item) => item.kind === 'websocket').length,
      messageCount: sorted.filter((item) => item.kind === 'worker' || item.kind === 'message').length,
      navigationCount: sorted.filter((item) => item.kind === 'navigation').length,
      linkedValueCount: links.filter((item) => item.traceId === id && item.confidence === 'exact').length,
    };
  }).sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
}
