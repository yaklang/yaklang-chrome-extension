import { describe, expect, it } from 'vitest';
import type { BrowserRecordingEvent } from '@/types/models';
import {
  boundRecordingPreviews,
  recordingEventPreviewBytes,
  recordingSerializedBytes,
} from './budget';

function event(id: string, preview: string): BrowserRecordingEvent {
  return {
    id,
    sequence: Number(id),
    timestamp: Number(id),
    recordingId: 'recording-1',
    traceId: 'trace-1',
    kind: 'crypto',
    operation: 'encrypt',
    inputs: [{ path: '$input', fingerprint: id, encoding: 'text', byteLength: preview.length, preview }],
    outputs: [],
    sensitiveCaptured: true,
    inputPreview: preview,
  };
}

describe('browser recording budgets', () => {
  it('drops oldest previews without removing event metadata or fingerprints', () => {
    const bounded = boundRecordingPreviews([
      event('1', 'a'.repeat(128)),
      event('2', 'b'.repeat(128)),
    ], 300);

    expect(bounded.events).toHaveLength(2);
    expect(bounded.events[0]).toMatchObject({ id: '1', sensitiveCaptured: false });
    expect(bounded.events[0].inputPreview).toBeUndefined();
    expect(bounded.events[0].inputs[0]).toMatchObject({ fingerprint: '1' });
    expect(bounded.events[1].inputPreview).toHaveLength(128);
    expect(bounded.retainedBytes).toBeLessThanOrEqual(300);
    expect(bounded.droppedCount).toBe(2);
  });

  it('counts UTF-8 bytes instead of JavaScript code units', () => {
    const value = event('1', '密钥');
    expect(recordingEventPreviewBytes(value)).toBe(12);
    expect(recordingSerializedBytes({ value: '密钥' })).toBeGreaterThan('{"value":""}'.length);
  });

  it('reports unserializable data as over budget', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(recordingSerializedBytes(cyclic)).toBe(Number.MAX_SAFE_INTEGER);
  });
});
