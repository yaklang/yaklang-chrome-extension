import type {
  BrowserRecordingEvent,
  BrowserRecordingSnapshot,
  BrowserRecordingValueEvidence,
} from '@/types/models';

function redactEvidence(
  evidence: BrowserRecordingValueEvidence,
): BrowserRecordingValueEvidence {
  const { preview: _preview, ...metadata } = evidence;
  return metadata;
}

function redactEvent(event: BrowserRecordingEvent): BrowserRecordingEvent {
  const {
    inputPreview: _inputPreview,
    outputPreview: _outputPreview,
    ...metadata
  } = event;
  return {
    ...metadata,
    inputs: event.inputs.map(redactEvidence),
    outputs: event.outputs.map(redactEvidence),
    sensitiveCaptured: false,
  };
}

/**
 * Returns the recording view allowed for the current caller without mutating
 * the full session snapshot. This matters after navigation: the internal
 * session intentionally retains explicitly captured short samples, while a
 * later metadata-only read must never inherit them through timeline merging.
 */
export function recordingSnapshotForScope(
  snapshot: BrowserRecordingSnapshot,
  allowSensitive: boolean,
): BrowserRecordingSnapshot {
  if (allowSensitive) return snapshot;
  return {
    ...snapshot,
    events: snapshot.events.map(redactEvent),
  };
}
