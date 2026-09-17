import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  executeScript: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  startNetwork: vi.fn(),
  listNetwork: vi.fn(),
  stopNetwork: vi.fn(),
  act: vi.fn(),
  context: vi.fn(),
  stageEvidence: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: { scripting: { executeScript: fixture.executeScript } },
}));
vi.mock('@/features/browser-recording/service', () => ({
  startBrowserRecording: fixture.startRecording,
  stopBrowserRecording: fixture.stopRecording,
}));
vi.mock('@/features/network-capture/service', () => ({
  startNetworkCapture: fixture.startNetwork,
  listNetworkRequests: fixture.listNetwork,
  stopNetworkCapture: fixture.stopNetwork,
}));
vi.mock('@/features/page-context/service', () => ({
  actOnPageNode: fixture.act,
  capturePageContext: fixture.context,
}));
vi.mock('@/features/browser-analysis/service', () => ({
  listRecordingTraces: vi.fn(() => [{ id: 'trace-1', cryptoCount: 1 }]),
  stageBrowserProfileEvidence: fixture.stageEvidence,
}));
vi.mock('@/platform/browser/targets', () => ({
  scriptingTarget: vi.fn((target) => ({ tabId: target.tabId, documentIds: [target.documentId] })),
}));

describe('atomic page crypto inspection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.executeScript
      .mockResolvedValueOnce([{ result: true }])
      .mockResolvedValueOnce([{ result: [{ type: 'alert', message: 'done', decision: 'auto_dismissed', timestamp: 2 }] }]);
    fixture.startRecording.mockResolvedValue({});
    fixture.stopRecording.mockResolvedValue({
      status: { target: { tabId: 7, frameId: 0, documentId: 'doc-1' }, active: false, documentAvailable: true, count: 1, droppedCount: 0 },
      events: [{
        id: 'event-1', sequence: 1, timestamp: 1, recordingId: 'recording-1', traceId: 'trace-1',
        kind: 'crypto', operation: 'AES.encrypt',
        crypto: { adapterId: 'cryptojs', providerKind: 'library', family: 'symmetric', operation: 'AES.encrypt', mode: 'CBC', padding: 'Pkcs7' },
        inputs: [], outputs: [], sensitiveCaptured: true,
      }],
      traces: [], links: [], callables: [], profileCandidates: [{
        id: 'candidate-1', direction: 'request', summary: 'login request',
        status: 'ready',
        confidence: { score: 0.95, level: 'high' },
        source: { eventId: 'event-1', callHandleId: 'handle-1' },
        sources: [],
        request: {
          method: 'POST', url: 'https://example.test/api', bodyFormat: 'json',
          mappings: [{ sourceEventId: 'event-1', destination: '$body.username' }],
        },
      }],
    });
    fixture.startNetwork.mockResolvedValue({});
    fixture.listNetwork.mockResolvedValue([{
      id: 'request-1', requestId: 'devtools-1', tabId: 7, frameId: 0,
      url: 'https://example.test/api', method: 'POST', resourceType: 'xmlhttprequest',
      startedAt: 1, completedAt: 2, statusCode: 200,
      requestHeadersCaptured: false, requestBodyCaptured: true,
      requestBody: { encoding: 'utf8', data: '{"cipher":"abc"}', byteLength: 16, truncated: false },
      redirects: [],
    }]);
    fixture.stopNetwork.mockResolvedValue({});
    fixture.act.mockResolvedValue({ action: 'click', status: 'dispatched', dispatchedAt: 1, node: { nodeId: 'n1' } });
    fixture.context.mockResolvedValue({
      captureId: 'capture-2',
      target: { tabId: 7, frameId: 0, documentId: 'doc-1' },
      authentication: { state: 'authenticated' },
      document: {
        title: 'Crypto lab', url: 'https://example.test/', readyState: 'complete', forms: [],
        interactive: [{ nodeId: 'n2', role: 'button', name: 'Next operation', visible: true }],
      },
    });
  });

  afterEach(() => vi.useRealTimers());

  it('captures one click, crypto evidence, request, and modal dialog in one call', async () => {
    const { inspectPageCryptoOperation } = await import('./inspect');
    const result = await inspectPageCryptoOperation(
      { tabId: 7, frameId: 0, documentId: 'doc-1' },
      { captureId: 'capture-1', nodeId: 'n1', settleMs: 250 },
      { grantId: 'paired', expiresAt: Date.now() + 60_000 },
    );

    expect(result).toMatchObject({
      state: 'observed',
      dialogs: [{ type: 'alert', message: 'done', decision: 'auto_dismissed' }],
      dialogHandling: { autoDismissedAlerts: 1, autoAcceptedConfirms: 0, autoSubmittedPrompts: 0, count: 1, navigationInferred: false },
      postAction: {
        sameDocument: true,
        captureId: 'capture-2',
        document: { interactive: [{ nodeId: 'n2', name: 'Next operation' }] },
      },
      recording: { count: 1, events: [{ kind: 'crypto', operation: 'AES.encrypt' }] },
      network: { count: 1, requests: [{ method: 'POST', statusCode: 200 }] },
      gatewayPreparation: {
        state: 'ready', candidateId: 'candidate-1',
        request: { method: 'POST', destinations: ['$body.username'] },
      },
    });
    expect(fixture.act).toHaveBeenCalledOnce();
    expect(fixture.stopRecording).toHaveBeenCalledOnce();
    expect(fixture.stopNetwork).toHaveBeenCalledOnce();
    expect(fixture.stageEvidence).toHaveBeenCalledOnce();
    expect(fixture.context).toHaveBeenCalledWith({ includeDom: true }, { tabId: 7, frameId: 0 });
  });

  it('prepares a response-only protocol when no request transform was observed', async () => {
    fixture.stopRecording.mockResolvedValueOnce({
      status: { target: { tabId: 7, frameId: 0, documentId: 'doc-1' }, active: false, documentAvailable: true, count: 1, droppedCount: 0 },
      events: [{
        id: 'decrypt-1', sequence: 1, timestamp: 1, recordingId: 'recording-1', traceId: 'trace-1',
        kind: 'crypto', operation: 'AES.decrypt', inputs: [], outputs: [], sensitiveCaptured: true,
      }],
      traces: [], links: [], callables: [], profileCandidates: [{
        id: 'candidate-response', recordingId: 'recording-1', traceId: 'trace-1', direction: 'response',
        status: 'ready', confidence: { score: 100, level: 'high' },
        source: { eventId: 'decrypt-1', callHandleId: 'handle-1' }, sources: [],
        request: { method: 'POST', url: 'https://example.test/api', bodyFormat: 'json', mappings: [] },
      }],
    });
    const { inspectPageCryptoOperation } = await import('./inspect');

    const result = await inspectPageCryptoOperation(
      { tabId: 7, frameId: 0, documentId: 'doc-1' },
      { captureId: 'capture-1', nodeId: 'n1', settleMs: 250 },
      { grantId: 'paired', expiresAt: Date.now() + 60_000 },
    );

    expect(result.gatewayPreparation).toMatchObject({
      state: 'ready',
      direction: 'response',
      directions: { request: { status: 'absent' }, response: { candidateId: 'candidate-response', status: 'ready' } },
    });
  });

  it('waits for a delayed request instead of treating an empty capture as idle', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const delayedRequest = {
      id: 'request-delayed', requestId: 'devtools-delayed', tabId: 7, frameId: 2,
      url: 'https://example.test/delayed', method: 'POST', resourceType: 'xmlhttprequest',
      startedAt: 1, completedAt: 2, statusCode: 200,
      requestHeadersCaptured: false, requestBodyCaptured: false, redirects: [],
    };
    fixture.listNetwork.mockImplementation(async () => (Date.now() - startedAt >= 900 ? [delayedRequest] : []));
    const { inspectPageCryptoOperation } = await import('./inspect');
    let settled = false;
    const pending = inspectPageCryptoOperation(
      { tabId: 7, frameId: 2, documentId: 'doc-frame' },
      { captureId: 'capture-1', nodeId: 'n1', settleMs: 1_500 },
      { grantId: 'paired', expiresAt: Date.now() + 60_000 },
    ).finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(800);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(800);
    const result = await pending;
    expect(result).toMatchObject({ network: { count: 1, requests: [{ id: 'request-delayed' }] } });
    expect(fixture.context).toHaveBeenCalledWith({ includeDom: true }, { tabId: 7, frameId: 2 });
  });

  it('handles alert, confirm, and prompt without blocking the page', async () => {
    const originalAlert = globalThis.alert;
    const originalConfirm = globalThis.confirm;
    const originalPrompt = globalThis.prompt;
    const alert = vi.fn();
    globalThis.alert = alert;
    const confirm = vi.fn(() => false);
    const prompt = vi.fn(() => 'typed value');
    globalThis.confirm = confirm;
    globalThis.prompt = prompt;
    try {
      const { installPageDialogCapture, restorePageDialogCapture } = await import('./inspect');
      expect(installPageDialogCapture()).toBe(true);
      globalThis.alert('notice');
      expect(globalThis.confirm('continue?')).toBe(true);
      expect(globalThis.prompt('name?')).toBe('');
      expect(restorePageDialogCapture()).toMatchObject([
        { type: 'alert', decision: 'auto_dismissed' },
        { type: 'confirm', decision: 'auto_accepted' },
        { type: 'prompt', decision: 'auto_submitted' },
      ]);
      expect(alert).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      globalThis.alert = originalAlert;
      globalThis.confirm = originalConfirm;
      globalThis.prompt = originalPrompt;
    }
  });
});
