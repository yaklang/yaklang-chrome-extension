import { describe, expect, it } from 'vitest';
import type { BrowserRecordingSnapshot } from '@/types/models';
import { recordingSnapshotForScope } from './redaction';

function snapshot(): BrowserRecordingSnapshot {
  return {
    status: {
      active: false,
      target: { tabId: 1, frameId: 0 },
      documentAvailable: true,
      count: 1,
      droppedCount: 0,
    },
    events: [{
      id: 'event-1',
      sequence: 1,
      timestamp: 1,
      recordingId: 'recording-1',
      traceId: 'trace-1',
      kind: 'fetch',
      source: 'page',
      operation: 'request',
      inputs: [{
        path: '$body:json.password',
        fingerprint: 'salted-fingerprint',
        encoding: 'text',
        byteLength: 6,
        preview: 'secret',
      }],
      outputs: [],
      sensitiveCaptured: true,
      inputPreview: '{"password":"secret"}',
      outputPreview: 'ciphertext',
    }],
    traces: [],
    links: [],
    callables: [],
    profileCandidates: [],
  };
}

describe('recordingSnapshotForScope', () => {
  it('removes cached previews from a metadata-only view without mutating the session snapshot', () => {
    const stored = snapshot();
    const metadata = recordingSnapshotForScope(stored, false);

    expect(JSON.stringify(metadata)).not.toContain('secret');
    expect(JSON.stringify(metadata)).not.toContain('ciphertext');
    expect(metadata.events[0].sensitiveCaptured).toBe(false);
    expect(stored.events[0].inputPreview).toContain('secret');
    expect(stored.events[0].inputs[0].preview).toBe('secret');
  });

  it('preserves the full session view only for an explicitly sensitive read', () => {
    const stored = snapshot();
    expect(recordingSnapshotForScope(stored, true)).toBe(stored);
  });
});
