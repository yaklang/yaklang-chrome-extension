import type { BrowserRecordingEvent } from '@/types/models';

export const RECORDING_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const RECORDING_GLOBAL_MAX_BYTES = 8 * 1024 * 1024;
export const RECORDING_MAX_SESSIONS = 32;
export const RECORDING_RETAINED_PREVIEW_MAX_BYTES = 512 * 1024;

const encoder = new TextEncoder();

export function recordingSerializedBytes(value: unknown): number {
  try {
    return encoder.encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function previewBytes(value: string | undefined): number {
  return value ? encoder.encode(value).byteLength : 0;
}

export function recordingEventPreviewBytes(event: BrowserRecordingEvent): number {
  return previewBytes(event.inputPreview)
    + previewBytes(event.outputPreview)
    + event.inputs.reduce((total, item) => total + previewBytes(item.preview), 0)
    + event.outputs.reduce((total, item) => total + previewBytes(item.preview), 0);
}

function withoutPreviews(event: BrowserRecordingEvent): {
  event: BrowserRecordingEvent;
  removed: number;
} {
  let removed = 0;
  if (event.inputPreview !== undefined) removed += 1;
  if (event.outputPreview !== undefined) removed += 1;
  const inputs = event.inputs.map((item) => {
    if (item.preview === undefined) return item;
    removed += 1;
    const { preview: _preview, ...metadata } = item;
    return metadata;
  });
  const outputs = event.outputs.map((item) => {
    if (item.preview === undefined) return item;
    removed += 1;
    const { preview: _preview, ...metadata } = item;
    return metadata;
  });
  if (!removed) return { event, removed: 0 };
  const { inputPreview: _input, outputPreview: _output, ...metadata } = event;
  return {
    event: {
      ...metadata,
      inputs,
      outputs,
      sensitiveCaptured: false,
    },
    removed,
  };
}

/**
 * Retains event metadata and exact fingerprints before discarding short-lived
 * plaintext previews. Oldest previews are removed first so the most recent
 * user action remains useful for local replay.
 */
export function boundRecordingPreviews(
  events: BrowserRecordingEvent[],
  maxBytes = RECORDING_RETAINED_PREVIEW_MAX_BYTES,
): { events: BrowserRecordingEvent[]; retainedBytes: number; droppedCount: number } {
  const bounded = [...events];
  let retainedBytes = bounded.reduce((total, event) => total + recordingEventPreviewBytes(event), 0);
  let droppedCount = 0;
  for (let index = 0; retainedBytes > maxBytes && index < bounded.length; index += 1) {
    const current = bounded[index];
    const bytes = recordingEventPreviewBytes(current);
    if (!bytes) continue;
    const stripped = withoutPreviews(current);
    bounded[index] = stripped.event;
    retainedBytes = Math.max(0, retainedBytes - bytes);
    droppedCount += stripped.removed;
  }
  return { events: bounded, retainedBytes, droppedCount };
}
