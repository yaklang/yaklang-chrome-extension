import { describe, expect, it } from 'vitest';
import type { BrowserRecordingValueEvidence } from '@/types/models';
import {
  createNetworkBoundaryRuntime,
  type NetworkBoundaryEvent,
} from './network';

class FakeXMLHttpRequest extends EventTarget {
  method = '';
  url = '';
  headers: Record<string, string> = {};
  sent: unknown[] = [];
  responseType: XMLHttpRequestResponseType = '';
  responseText = '';
  response: unknown = '';
  responseURL = '';
  status = 0;

  getAllResponseHeaders(): string {
    return 'content-type: application/json\r\nx-trace: response-trace\r\n';
  }

  open(method: string, url: string | URL): void {
    this.method = method;
    this.url = String(url);
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body?: unknown): void {
    this.sent.push(body);
  }

  complete(): void {
    this.dispatchEvent(new Event('loadend'));
  }
}

class FakeWebSocket extends EventTarget {
  sent: unknown[] = [];

  constructor(readonly url: string) {
    super();
  }

  send(value: unknown): void {
    this.sent.push(value);
  }

  reply(value: unknown): void {
    const event = new Event('message');
    Object.defineProperty(event, 'data', { value });
    this.dispatchEvent(event);
  }

  opened(): void {
    this.dispatchEvent(new Event('open'));
  }

  closed(wasClean: boolean, code: number): void {
    const event = new Event('close');
    Object.defineProperties(event, {
      wasClean: { value: wasClean },
      code: { value: code },
    });
    this.dispatchEvent(event);
  }
}

class FakeForm {
  method = 'get';
  action = '';
  fields: Record<string, string> = {};
}

class FakeFormData {
  constructor(readonly form: FakeForm) {}

  toString(): string {
    return new URLSearchParams(this.form.fields).toString();
  }
}

class FakeDocument {
  private listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const current = this.listeners.get(type) || new Set<EventListener>();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  submit(form: FakeForm): void {
    for (const listener of this.listeners.get('submit') || []) {
      listener({ target: form } as unknown as Event);
    }
  }
}

function evidence(value: unknown, path: string): BrowserRecordingValueEvidence[] {
  if (value === undefined) return [];
  const text = String(value);
  return [{
    path,
    fingerprint: `fp:${text}`,
    encoding: 'text',
    byteLength: text.length,
  }];
}

function environment() {
  const events: NetworkBoundaryEvent[] = [];
  const fetchCalls: Array<{ input: unknown; init: unknown }> = [];
  const pageDocument = new FakeDocument();
  const originalFetch: typeof fetch = function pageFetch(input, init) {
    fetchCalls.push({ input, init });
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  const scope = {
    document: pageDocument,
    location: { href: 'https://example.test/current' },
    fetch: originalFetch,
    Headers,
    Request,
    Response,
    XMLHttpRequest: FakeXMLHttpRequest,
    HTMLFormElement: FakeForm,
    FormData: FakeFormData,
    Blob,
    ReadableStream,
    ReadableStreamDefaultReader,
    ReadableStreamBYOBReader,
    WebSocket: FakeWebSocket,
  } as unknown as Window & {
    fetch: typeof originalFetch;
    XMLHttpRequest: typeof FakeXMLHttpRequest;
    WebSocket: typeof FakeWebSocket;
    document: FakeDocument;
  };
  let sequence = 0;
  const runtime = createNetworkBoundaryRuntime(scope, {
    unique: (prefix) => `${prefix}-${++sequence}`,
    byteLength: (value) => {
      if (value instanceof Blob) return value.size;
      if (value instanceof ArrayBuffer) return value.byteLength;
      if (ArrayBuffer.isView(value)) return value.byteLength;
      return value === undefined ? undefined : String(value).length;
    },
    dataType: (value) => value?.constructor?.name || typeof value,
    asBytes: (value) => value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : undefined,
    preview: (value) => value === undefined ? undefined : String(value),
    collectEvidence: evidence,
    stackInfo: () => ({ scriptUrl: 'https://example.test/app.js' }),
    emit: (event) => events.push(event),
  });
  return { events, fetchCalls, originalFetch, runtime, scope };
}

describe('network boundary runtime', () => {
  it('records Fetch, XHR and Form requests while preserving page transports', async () => {
    const { events, fetchCalls, originalFetch, runtime, scope } = environment();
    const originalOpen = FakeXMLHttpRequest.prototype.open;
    const originalSend = FakeXMLHttpRequest.prototype.send;
    runtime.start();

    const fetchResult = await scope.fetch('/login?tenant=alpha', {
      method: 'POST',
      headers: { 'X-Signature': 'signature-value' },
      body: 'plain-body',
    });
    const xhr = new scope.XMLHttpRequest();
    xhr.open('POST', '/xhr?nonce=one');
    xhr.setRequestHeader('X-Trace', 'trace-value');
    xhr.send('xhr-body');

    const form = new FakeForm();
    form.method = 'POST';
    form.action = 'https://example.test/form?flow=login';
    form.fields.account = 'admin';
    scope.document.submit(form);

    expect(fetchResult.ok).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(xhr.sent).toEqual(['xhr-body']);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'fetch',
        method: 'POST',
        url: 'https://example.test/login?tenant=alpha',
      }),
      expect.objectContaining({
        kind: 'xhr',
        method: 'POST',
        url: 'https://example.test/xhr?nonce=one',
      }),
      expect.objectContaining({
        kind: 'form',
        method: 'POST',
      }),
    ]));
    expect(events.find((event) => event.kind === 'fetch')?.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '$body' }),
      expect.objectContaining({ path: '$headers.x-signature' }),
      expect.objectContaining({ path: '$query.tenant' }),
    ]));

    runtime.stop();
    expect(scope.fetch).toBe(originalFetch);
    expect(FakeXMLHttpRequest.prototype.open).toBe(originalOpen);
    expect(FakeXMLHttpRequest.prototype.send).toBe(originalSend);
  });

  it('correlates WebSocket lifecycle and frames and restores every tracked socket', () => {
    const { events, runtime, scope } = environment();
    const OriginalWebSocket = scope.WebSocket;
    const originalSend = FakeWebSocket.prototype.send;
    runtime.start();

    const socket = new scope.WebSocket('wss://example.test/stream');
    socket.opened();
    socket.send('plain-frame');
    socket.reply('cipher-frame');
    socket.closed(false, 1006);

    expect(socket.sent).toEqual(['plain-frame']);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'websocket', operation: 'construct' }),
      expect.objectContaining({ kind: 'websocket', operation: 'open' }),
      expect.objectContaining({ kind: 'websocket', operation: 'frame', direction: 'send' }),
      expect.objectContaining({ kind: 'websocket', operation: 'frame', direction: 'receive' }),
      expect.objectContaining({ kind: 'websocket', operation: 'close', error: 'code=1006' }),
    ]));
    const frames = events.filter((event) => event.operation === 'frame');
    expect(new Set(frames.map((event) => event.socketId)).size).toBe(1);

    runtime.stop();
    expect(scope.WebSocket).toBe(OriginalWebSocket);
    expect(socket.send).toBe(originalSend);
  });

  it('records Fetch response bodies through native readers without consuming the page response', async () => {
    const setup = environment();
    setup.scope.fetch = (async () => new Response(JSON.stringify({ encryptedData: 'ciphertext' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json', 'X-Trace': 'response-trace' },
    })) as typeof setup.scope.fetch;
    setup.runtime.start();

    const response = await setup.scope.fetch('/encrypted', { method: 'POST', body: 'request-body' });
    const clone = response.clone();
    await expect(response.json()).resolves.toEqual({ encryptedData: 'ciphertext' });
    await expect(clone.text()).resolves.toBe('{"encryptedData":"ciphertext"}');
    await Promise.resolve();

    const request = setup.events.find((event) => event.kind === 'fetch' && event.operation === 'request');
    const received = setup.events.find((event) => event.kind === 'fetch' && event.operation === 'response');
    expect(request).toMatchObject({ direction: 'send', method: 'POST' });
    expect(received).toMatchObject({
      direction: 'receive', method: 'POST', statusCode: 201, channelId: request?.channelId,
    });
    expect(received?.outputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '$body' }),
      expect.objectContaining({ path: '$headers.content-type' }),
    ]));
    expect(setup.events.filter((event) => event.operation === 'response')).toHaveLength(1);

    setup.runtime.stop();
  });

  it('records XHR response values and keeps the request and response on one channel', () => {
    const { events, runtime, scope } = environment();
    runtime.start();
    const xhr = new scope.XMLHttpRequest();
    xhr.open('POST', '/encrypted-xhr');
    xhr.send('request-body');
    Object.assign(xhr, {
      status: 200,
      responseURL: 'https://example.test/encrypted-xhr',
      responseText: '{"encryptedData":"ciphertext"}',
      response: '{"encryptedData":"ciphertext"}',
    });
    xhr.complete();

    const request = events.find((event) => event.kind === 'xhr' && event.operation === 'request');
    const received = events.find((event) => event.kind === 'xhr' && event.operation === 'response');
    expect(received).toMatchObject({
      direction: 'receive', method: 'POST', statusCode: 200, channelId: request?.channelId,
    });
    expect(received?.outputs).toEqual(expect.arrayContaining([expect.objectContaining({ path: '$body' })]));
    runtime.stop();
  });

  it('observes streamed response chunks without reading ahead or changing backpressure', async () => {
    const setup = environment();
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])];
    setup.scope.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }), { status: 200 })) as typeof setup.scope.fetch;
    setup.runtime.start();

    const response = await setup.scope.fetch('/stream');
    const reader = response.body!.getReader();
    const received: number[][] = [];
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      received.push([...item.value]);
    }
    await Promise.resolve();

    expect(received).toEqual([[1, 2], [3, 4, 5]]);
    expect(setup.events.filter((event) => event.operation === 'response.chunk')).toHaveLength(2);
    expect(setup.events.find((event) => event.operation === 'response')).toMatchObject({
      resultByteLength: 5,
      dataType: 'Uint8Array',
    });
    setup.runtime.stop();
  });

  it('captures binary WebSocket ArrayBuffer and Blob frames on one correlated channel', async () => {
    const { events, runtime, scope } = environment();
    runtime.start();
    const socket = new scope.WebSocket('wss://example.test/binary');
    socket.send(new Uint8Array([1, 2, 3]));
    socket.reply(new Blob([new Uint8Array([4, 5, 6, 7])]));
    await Promise.resolve();
    await Promise.resolve();

    const frames = events.filter((event) => event.operation === 'frame');
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ direction: 'send', byteLength: 3, dataType: 'Uint8Array' });
    expect(frames[1]).toMatchObject({ direction: 'receive', resultByteLength: 4, dataType: 'Blob' });
    expect(new Set(frames.map((event) => event.channelId)).size).toBe(1);
    expect(frames[1].outputs).toEqual(expect.arrayContaining([expect.objectContaining({ path: '$frame' })]));
    runtime.stop();
  });
});
