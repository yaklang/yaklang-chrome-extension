import type { BrowserRecordingEvent } from '@/types/models';

export interface RecordingTraceContext {
  traceId: string;
  interactionId?: string;
}

export type RecordingTraceEventInput = Omit<BrowserRecordingEvent,
  | 'id'
  | 'sequence'
  | 'timestamp'
  | 'recordingId'
  | 'traceId'
  | 'interactionId'
  | 'parentEventId'
  | 'sensitiveCaptured'
  | 'inputs'
  | 'outputs'
> & {
  inputs?: BrowserRecordingEvent['inputs'];
  outputs?: BrowserRecordingEvent['outputs'];
};

export interface RecordingTraceHost {
  active(): boolean;
  recordingId(): string | undefined;
  captureValues(): boolean;
  maxEntries(): number;
  parentEventId(): string | undefined;
  unique(prefix: string): string;
}

export interface RecordingTraceSnapshot {
  count: number;
  droppedCount: number;
  sequence: number;
  events: BrowserRecordingEvent[];
}

export interface RecordingTraceRuntime {
  context(): RecordingTraceContext;
  currentContext(): RecordingTraceContext | undefined;
  bindContext(context: RecordingTraceContext): void;
  releaseContext(): void;
  record(input: RecordingTraceEventInput, context?: RecordingTraceContext): BrowserRecordingEvent | undefined;
  observe(
    factory: () => RecordingTraceEventInput,
    context?: RecordingTraceContext,
  ): BrowserRecordingEvent | undefined;
  reset(sequenceStart?: number): void;
  advanceSequenceStart(sequenceStart: number): void;
  snapshot(limit: number): RecordingTraceSnapshot;
}

const TRACE_IDLE_MS = 5_000;

export function createRecordingTraceRuntime(
  host: RecordingTraceHost,
  now = () => performance.now(),
): RecordingTraceRuntime {
  let sequence = 0;
  let droppedCount = 0;
  let events: BrowserRecordingEvent[] = [];
  let currentTrace: (RecordingTraceContext & { expiresAt: number }) | undefined;

  const bindContext = (context: RecordingTraceContext): void => {
    currentTrace = { ...context, expiresAt: now() + TRACE_IDLE_MS };
  };

  const currentContext = (): RecordingTraceContext | undefined => {
    const currentTime = now();
    if (!currentTrace || currentTrace.expiresAt < currentTime) return undefined;
    currentTrace.expiresAt = currentTime + TRACE_IDLE_MS;
    return {
      traceId: currentTrace.traceId,
      interactionId: currentTrace.interactionId,
    };
  };

  const context = (): RecordingTraceContext => {
    const existing = currentContext();
    if (existing) return existing;
    const created = { traceId: host.unique('trace') };
    bindContext(created);
    return created;
  };

  const record = (
    input: RecordingTraceEventInput,
    explicitContext?: RecordingTraceContext,
  ): BrowserRecordingEvent | undefined => {
    const recordingId = host.recordingId();
    if (!host.active() || !recordingId) return undefined;
    const eventContext = explicitContext || context();
    sequence += 1;
    const item: BrowserRecordingEvent = {
      id: host.unique('event'),
      sequence,
      timestamp: Date.now(),
      recordingId,
      traceId: eventContext.traceId,
      interactionId: eventContext.interactionId,
      parentEventId: host.parentEventId(),
      source: 'page',
      sensitiveCaptured: host.captureValues(),
      inputs: input.inputs || [],
      outputs: input.outputs || [],
      ...input,
    };
    events.push(item);
    const configuredMaxEntries = host.maxEntries();
    const maxEntries = Number.isSafeInteger(configuredMaxEntries) && configuredMaxEntries > 0
      ? configuredMaxEntries
      : 1;
    while (events.length > maxEntries) {
      events.shift();
      droppedCount += 1;
    }
    return item;
  };

  return {
    context,
    currentContext,
    bindContext,
    releaseContext() {
      currentTrace = undefined;
    },
    record,
    observe(factory, explicitContext) {
      if (!host.active() || !host.recordingId()) return undefined;
      try {
        return record(factory(), explicitContext);
      } catch {
        droppedCount += 1;
        return undefined;
      }
    },
    reset(sequenceStart = 0) {
      events = [];
      droppedCount = 0;
      sequence = Number.isSafeInteger(sequenceStart) && sequenceStart >= 0 ? sequenceStart : 0;
      currentTrace = undefined;
    },
    advanceSequenceStart(sequenceStart) {
      if (Number.isSafeInteger(sequenceStart) && sequenceStart >= sequence) sequence = sequenceStart;
    },
    snapshot(limit) {
      const configuredMaxEntries = host.maxEntries();
      const maxEntries = Number.isSafeInteger(configuredMaxEntries) && configuredMaxEntries > 0
        ? configuredMaxEntries
        : 1;
      const normalizedLimit = Number.isSafeInteger(limit) && limit >= 0
        ? Math.min(limit, maxEntries)
        : maxEntries;
      return {
        count: events.length,
        droppedCount,
        sequence,
        events: normalizedLimit === 0 ? [] : events.slice(-normalizedLimit),
      };
    },
  };
}
