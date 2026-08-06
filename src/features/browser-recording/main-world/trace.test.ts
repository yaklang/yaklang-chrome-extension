import { describe, expect, it } from 'vitest';
import { createRecordingTraceRuntime } from './trace';

function environment() {
  let active = true;
  let recordingId: string | undefined = 'recording-1';
  let captureValues = false;
  let maxEntries = 3;
  let parentEventId: string | undefined;
  let uniqueSequence = 0;
  let currentTime = 1_000;
  const runtime = createRecordingTraceRuntime({
    active: () => active,
    recordingId: () => recordingId,
    captureValues: () => captureValues,
    maxEntries: () => maxEntries,
    parentEventId: () => parentEventId,
    unique: (prefix) => `${prefix}-${++uniqueSequence}`,
  }, () => currentTime);
  return {
    runtime,
    setActive(value: boolean) {
      active = value;
    },
    setRecordingId(value: string | undefined) {
      recordingId = value;
    },
    setCaptureValues(value: boolean) {
      captureValues = value;
    },
    setMaxEntries(value: number) {
      maxEntries = value;
    },
    setParentEventId(value: string | undefined) {
      parentEventId = value;
    },
    advance(milliseconds: number) {
      currentTime += milliseconds;
    },
  };
}

describe('recording trace runtime', () => {
  it('does not create events or trace state while recording is inactive', () => {
    const environmentState = environment();
    environmentState.setActive(false);

    expect(environmentState.runtime.record({ kind: 'interaction', operation: 'click' })).toBeUndefined();
    expect(environmentState.runtime.observe(() => {
      throw new Error('factory must not run');
    })).toBeUndefined();
    expect(environmentState.runtime.currentContext()).toBeUndefined();
    expect(environmentState.runtime.snapshot(10)).toEqual({
      count: 0,
      droppedCount: 0,
      sequence: 0,
      events: [],
    });
  });

  it('binds interaction context and preserves parent and sensitivity metadata', () => {
    const environmentState = environment();
    environmentState.setCaptureValues(true);
    environmentState.setParentEventId('crypto-parent');
    environmentState.runtime.bindContext({ traceId: 'trace-login', interactionId: 'interaction-submit' });

    const event = environmentState.runtime.record({
      kind: 'fetch',
      operation: 'POST',
      inputs: [],
      outputs: [],
    });

    expect(event).toEqual(expect.objectContaining({
      id: 'event-1',
      recordingId: 'recording-1',
      traceId: 'trace-login',
      interactionId: 'interaction-submit',
      parentEventId: 'crypto-parent',
      sensitiveCaptured: true,
      sequence: 1,
    }));
  });

  it('reuses an active trace and creates a new trace after the idle window', () => {
    const environmentState = environment();
    const first = environmentState.runtime.record({ kind: 'transform', operation: 'first' });
    environmentState.advance(4_999);
    const second = environmentState.runtime.record({ kind: 'transform', operation: 'second' });
    environmentState.advance(5_001);
    const third = environmentState.runtime.record({ kind: 'transform', operation: 'third' });

    expect(second?.traceId).toBe(first?.traceId);
    expect(third?.traceId).not.toBe(first?.traceId);
  });

  it('keeps sequence monotonic while evicting bounded history', () => {
    const environmentState = environment();
    environmentState.setMaxEntries(2);

    environmentState.runtime.record({ kind: 'interaction', operation: 'one' });
    environmentState.runtime.record({ kind: 'interaction', operation: 'two' });
    environmentState.runtime.record({ kind: 'interaction', operation: 'three' });

    const snapshot = environmentState.runtime.snapshot(10);
    expect(snapshot.count).toBe(2);
    expect(snapshot.droppedCount).toBe(1);
    expect(snapshot.sequence).toBe(3);
    expect(snapshot.events.map((event) => event.operation)).toEqual(['two', 'three']);
  });

  it('isolates observer errors and supports reset and resumed sequence starts', () => {
    const environmentState = environment();
    environmentState.runtime.record({ kind: 'interaction', operation: 'before-reset' });
    expect(environmentState.runtime.observe(() => {
      throw new Error('broken observer');
    })).toBeUndefined();
    expect(environmentState.runtime.snapshot(10).droppedCount).toBe(1);

    environmentState.runtime.reset(8);
    environmentState.runtime.advanceSequenceStart(12);
    const event = environmentState.runtime.record({ kind: 'navigation', operation: 'navigate' });

    expect(event?.sequence).toBe(13);
    expect(environmentState.runtime.snapshot(0)).toEqual({
      count: 1,
      droppedCount: 0,
      sequence: 13,
      events: [],
    });
  });

  it('does not evaluate an observer factory without a recording identity', () => {
    const environmentState = environment();
    environmentState.setRecordingId(undefined);
    let evaluated = false;

    environmentState.runtime.observe(() => {
      evaluated = true;
      return { kind: 'interaction', operation: 'click' };
    });

    expect(evaluated).toBe(false);
    expect(environmentState.runtime.snapshot(10).events).toEqual([]);
  });
});
