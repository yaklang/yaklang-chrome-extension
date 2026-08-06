import { describe, expect, it, vi } from 'vitest';
import type {
  BrowserPageCallable,
  BrowserProfileInferenceCandidate,
  BrowserRecordingEvent,
  BrowserRecordingSnapshot,
  BrowserTransformExecution,
  BrowserTransformPacket,
  BrowserTransformValidationDraft,
} from '@/types/models';

vi.mock('wxt/browser', () => {
  const event = { addListener: vi.fn() };
  return {
    browser: {
      tabs: { onRemoved: event, onCreated: event },
      webNavigation: {
        onBeforeNavigate: event,
        onCommitted: event,
        onDOMContentLoaded: event,
        onCompleted: event,
        onHistoryStateUpdated: event,
        onReferenceFragmentUpdated: event,
        onErrorOccurred: event,
      },
    },
  };
});

import {
  applyTransformExecution,
  assertBrowserTransformValidationDraftBudget,
  BROWSER_TRANSFORM_VALIDATION_DRAFT_MAX_BYTES,
  compareBrowserPackets,
  comparePacketWithInferenceCandidate,
  inspectRecordingEvidence,
  listRecordingTraces,
  promoteObservedEnvelopeCallable,
} from './service';

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function packet(body: string, contentType: string, url = 'https://example.test/login'): BrowserTransformPacket {
  return {
    method: 'POST',
    url,
    headers: [{ name: 'Content-Type', value: contentType }],
    bodyBase64: base64(body),
  };
}

function formCandidate(): BrowserProfileInferenceCandidate {
  return {
    id: 'candidate-1',
    target: { tabId: 1, frameId: 0 },
    request: {
      eventId: 'request-1',
      method: 'POST',
      url: 'https://example.test/login',
      bodyFormat: 'form',
      destination: 'body.encryptedData',
      serialization: 'form-field',
      mappings: [{
        sourceEventId: 'crypto-1',
        destination: 'body.encryptedData',
        serialization: 'form-field',
      }],
    },
  } as BrowserProfileInferenceCandidate;
}

describe('browser analysis deterministic tools', () => {
  it('bounds validation drafts before session persistence', () => {
    const draft = {
      contractVersion: 1,
      id: 'validation-1',
      profile: {
        name: 'bounded profile',
      },
      proofLevel: 'execution-only',
      createdAt: 1,
      expiresAt: 2,
    } as BrowserTransformValidationDraft;
    expect(() => assertBrowserTransformValidationDraftBudget(draft)).not.toThrow();
    expect(() => assertBrowserTransformValidationDraftBudget({
      ...draft,
      profile: {
        ...draft.profile,
        name: 'x'.repeat(BROWSER_TRANSFORM_VALIDATION_DRAFT_MAX_BYTES),
      },
    })).toThrow(/验证草稿超过/);
  });

  it('compares randomized encrypted packets by route and structure instead of ciphertext bytes', () => {
    const actual = packet(
      JSON.stringify({ encryptedData: 'random-a', encryptedKey: 'random-key-a', encryptedIv: 'random-iv-a' }),
      'application/json',
    );
    const expected = packet(
      JSON.stringify({ encryptedData: 'random-b', encryptedKey: 'random-key-b', encryptedIv: 'random-iv-b' }),
      'application/json',
    );
    expect(compareBrowserPackets(actual, expected)).toMatchObject({
      mode: 'structure',
      equivalent: true,
    });
    expect(compareBrowserPackets(actual, expected, 'exact')).toMatchObject({
      mode: 'exact',
      equivalent: false,
    });
  });

  it('detects the nested AES envelope regression', () => {
    const actual = packet(
      `encryptedData=${encodeURIComponent(JSON.stringify({ encryptedData: 'cipher' }))}`,
      'application/x-www-form-urlencoded',
    );
    const expected = packet(
      `encryptedData=${encodeURIComponent('cipher')}`,
      'application/x-www-form-urlencoded',
    );
    const comparison = compareBrowserPackets(actual, expected);
    expect(comparison.equivalent).toBe(false);
    expect(comparison.checks.find((item) => item.id === 'body-shape')?.status).toBe('fail');
    expect(compareBrowserPackets(actual, expected, 'exact').equivalent).toBe(false);
  });

  it('validates a generated packet directly against recorded candidate evidence', () => {
    const candidate = formCandidate();
    expect(comparePacketWithInferenceCandidate(
      packet('encryptedData=cipher', 'application/x-www-form-urlencoded'),
      candidate,
    )).toMatchObject({
      mode: 'structure',
      equivalent: true,
    });
    expect(comparePacketWithInferenceCandidate(
      packet(
        `encryptedData=${encodeURIComponent(JSON.stringify({ encryptedData: 'cipher' }))}`,
        'application/x-www-form-urlencoded',
      ),
      candidate,
    )).toMatchObject({
      equivalent: false,
    });
    const legacyRelativeCandidate = formCandidate();
    legacyRelativeCandidate.request.url = 'encrypt/aes.php';
    expect(comparePacketWithInferenceCandidate(
      packet('encryptedData=cipher', 'application/x-www-form-urlencoded'),
      legacyRelativeCandidate,
    )).toMatchObject({
      equivalent: false,
    });
  });

  it('applies transformed headers and body without duplicating content type', () => {
    const input = packet('{"username":"admin"}', 'application/json');
    const execution: BrowserTransformExecution = {
      profileId: 'validation-1',
      direction: 'request',
      url: input.url,
      bodyBase64: base64('encryptedData=cipher'),
      setHeaders: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
      removeHeaders: [],
      logicalInput: {},
      logicalOutput: {},
      nodeDurations: [],
      nodeTrace: [],
      fieldChanges: [],
      durationMs: 1,
    };
    const output = applyTransformExecution(input, execution);
    expect(output.headers).toEqual([
      { name: 'Content-Type', value: 'application/x-www-form-urlencoded' },
    ]);
  });

  it('promotes a replayed object to a complete envelope only when its keys match the recorded request', () => {
    const callable = {
      id: 'callable-1',
      name: 'Opaque envelope',
      kind: 'business-closure',
      operation: 'buildEnvelope',
      origin: 'https://example.test',
      target: { tabId: 1, frameId: 0, documentId: 'document-1' },
      lifecycle: 'document',
      execution: { resultMode: 'auto', timeoutMs: 8_000 },
      inputSlots: [{ id: 'arg-0', name: 'payload', index: 0, role: 'data', dataType: 'object', required: true, retained: false }],
      output: { dataType: 'unknown', encoding: 'auto', shape: 'value', paths: [] },
      provenance: {},
      createdAt: 1,
    } satisfies BrowserPageCallable;
    const request = {
      inputs: [
        { path: '$body:json.blob_random', fingerprint: 'blob', encoding: 'text', byteLength: 32 },
        { path: '$body:json.proof_random', fingerprint: 'proof', encoding: 'text', byteLength: 44 },
        { path: '$headers.content-type', fingerprint: 'header', encoding: 'text', byteLength: 16 },
      ],
    } as BrowserRecordingEvent;

    expect(promoteObservedEnvelopeCallable(
      callable,
      request,
      ['proof_random', 'blob_random'],
    ).output).toEqual({
      dataType: 'object',
      encoding: 'json',
      shape: 'envelope',
      paths: ['body.blob_random', 'body.proof_random'],
    });
    expect(promoteObservedEnvelopeCallable(
      callable,
      request,
      ['proof_random'],
    )).toBe(callable);
  });

  it('keeps trace discovery metadata-only until values are explicitly requested', () => {
    const snapshot = {
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
        operation: 'request',
        method: 'POST',
        url: 'https://example.test/login?token=secret',
        inputs: [{
          path: '$body:json.password',
          fingerprint: 'salted',
          encoding: 'text',
          byteLength: 6,
          preview: 'secret',
        }],
        outputs: [],
        sensitiveCaptured: true,
        inputPreview: '{"password":"secret"}',
      }],
      traces: [{
        id: 'trace-1',
        label: '登录',
        startedAt: 1,
        endedAt: 2,
        eventIds: ['event-1'],
        requestCount: 1,
        cryptoCount: 0,
        websocketCount: 0,
        messageCount: 0,
        navigationCount: 0,
        linkedValueCount: 0,
      }],
      links: [],
      callables: [],
      profileCandidates: [],
    } satisfies BrowserRecordingSnapshot;

    expect(JSON.stringify(listRecordingTraces(snapshot))).not.toContain('secret');
    expect(JSON.stringify(inspectRecordingEvidence(snapshot, 'trace-1'))).not.toContain('secret');
    expect(inspectRecordingEvidence(snapshot, 'trace-1')).toMatchObject({
      valuePolicy: 'metadata-only',
    });
    expect(JSON.stringify(inspectRecordingEvidence(snapshot, 'trace-1', undefined, true))).toContain('password');
  });
});
