import { describe, expect, it } from 'vitest';
import type { BrowserRecordingValueEvidence } from '@/types/models';
import {
  createCommunicationBoundaryRuntime,
  type CommunicationBoundaryEvent,
} from './communication';

class FakeNavigator {
  beacons: Array<{ url: string; data: unknown }> = [];

  sendBeacon(url: string, data?: unknown): boolean {
    this.beacons.push({ url, data });
    return true;
  }
}

class FakeWorker extends EventTarget {
  sent: unknown[] = [];

  constructor(readonly url: string) {
    super();
  }

  postMessage(value: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions): void {
    const transfer = Array.isArray(transferOrOptions) ? transferOrOptions : transferOrOptions?.transfer;
    this.sent.push(transfer?.length ? structuredClone(value, { transfer }) : value);
  }

  reply(value: unknown): void {
    const event = new Event('message');
    Object.defineProperties(event, {
      data: { value },
      ports: { value: [] },
    });
    this.dispatchEvent(event);
  }
}

class FakeMessagePort extends EventTarget {
  sent: unknown[] = [];

  postMessage(value: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions): void {
    const transfer = Array.isArray(transferOrOptions) ? transferOrOptions : transferOrOptions?.transfer;
    this.sent.push(transfer?.length ? structuredClone(value, { transfer }) : value);
  }

  reply(value: unknown): void {
    const event = new Event('message');
    Object.defineProperties(event, {
      data: { value },
      ports: { value: [] },
    });
    this.dispatchEvent(event);
  }
}

class FakeMessageChannel {
  port1 = new FakeMessagePort();
  port2 = new FakeMessagePort();
}

function fakeWindow(): Window & {
  navigator: FakeNavigator;
  Worker: typeof FakeWorker;
  MessagePort: typeof FakeMessagePort;
  MessageChannel: typeof FakeMessageChannel;
} {
  const target = new EventTarget() as EventTarget & Record<string, unknown>;
  target.navigator = new FakeNavigator();
  target.Worker = FakeWorker;
  target.MessagePort = FakeMessagePort;
  target.MessageChannel = FakeMessageChannel;
  return target as unknown as ReturnType<typeof fakeWindow>;
}

function evidence(value: unknown, path: string): BrowserRecordingValueEvidence[] {
  return [{ path, fingerprint: `value:${JSON.stringify(value)}`, encoding: 'json', byteLength: 1 }];
}

describe('communication boundary runtime', () => {
  it('preserves page APIs while correlating Worker send and receive in the originating trace', () => {
    const scope = fakeWindow();
    const originalWorker = scope.Worker;
    const originalPostMessage = FakeWorker.prototype.postMessage;
    const emitted: Array<{ event: CommunicationBoundaryEvent; context?: { traceId: string } }> = [];
    let sequence = 0;
    const runtime = createCommunicationBoundaryRuntime(scope, {
      unique: (prefix) => `${prefix}-${++sequence}`,
      describe: (value, path) => ({ dataType: typeof value, byteLength: 1, evidence: evidence(value, path) }),
      stackInfo: () => ({ scriptUrl: 'https://example.test/app.js' }),
      emit(event, context) {
        const resolved = context || { traceId: `trace-${sequence}` };
        emitted.push({ event, context: resolved });
        return { ...resolved, scriptUrl: event.scriptUrl };
      },
      afterWrapperInvoke: () => undefined,
    });

    runtime.start();
    const worker = new scope.Worker('/worker.js');
    worker.postMessage({ plain: true });
    worker.reply({ cipher: true });

    const send = emitted.find((item) => item.event.operation === 'worker.postMessage');
    const receive = emitted.find((item) => item.event.operation === 'worker.message');
    expect(worker.sent).toEqual([{ plain: true }]);
    expect(send?.event).toMatchObject({ kind: 'worker', direction: 'send', wrapperHandleId: expect.any(String) });
    expect(receive?.event).toMatchObject({ kind: 'worker', direction: 'receive', channelId: send?.event.channelId });
    expect(receive?.context?.traceId).toBe(send?.context?.traceId);
    expect(runtime.wrapperFunction(send?.event.wrapperHandleId || '')).toBe(FakeWorker.prototype.postMessage);

    runtime.stop();
    expect(scope.Worker).toBe(originalWorker);
    expect(FakeWorker.prototype.postMessage).toBe(originalPostMessage);
    expect(runtime.wrapperFunction(send?.event.wrapperHandleId || '')).toBeUndefined();
  });

  it('records Beacon and MessagePort boundaries without changing return values', () => {
    const scope = fakeWindow();
    const emitted: CommunicationBoundaryEvent[] = [];
    let sequence = 0;
    const runtime = createCommunicationBoundaryRuntime(scope, {
      unique: (prefix) => `${prefix}-${++sequence}`,
      describe: (value, path) => ({ dataType: typeof value, byteLength: 1, evidence: evidence(value, path) }),
      stackInfo: () => ({}),
      emit(event, context) {
        emitted.push(event);
        return { traceId: context?.traceId || 'trace-1' };
      },
      afterWrapperInvoke: () => undefined,
    });

    runtime.start();
    expect(scope.navigator.sendBeacon('/audit', 'payload')).toBe(true);
    const channel = new scope.MessageChannel();
    channel.port1.postMessage('plain');
    channel.port1.reply('cipher');

    expect(scope.navigator.beacons).toEqual([{ url: '/audit', data: 'payload' }]);
    expect(emitted.map((item) => item.operation)).toEqual(expect.arrayContaining([
      'request', 'message-port.postMessage', 'message-port.message',
    ]));
    expect(emitted.find((item) => item.operation === 'request')).toMatchObject({
      kind: 'beacon', method: 'POST', wrapperHandleId: expect.any(String),
    });
    runtime.stop();
  });

  it('fingerprints transferable ArrayBuffer values before the page transfers ownership', () => {
    const scope = fakeWindow();
    const emitted: CommunicationBoundaryEvent[] = [];
    let sequence = 0;
    const runtime = createCommunicationBoundaryRuntime(scope, {
      unique: (prefix) => `${prefix}-${++sequence}`,
      describe(value, path) {
        const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : undefined;
        return {
          dataType: value?.constructor?.name || typeof value,
          byteLength: bytes?.byteLength,
          evidence: [{
            path,
            fingerprint: `bytes:${bytes ? [...bytes].join(',') : ''}`,
            encoding: 'hex',
            byteLength: bytes?.byteLength || 0,
          }],
        };
      },
      stackInfo: () => ({}),
      emit(event, context) {
        emitted.push(event);
        return { traceId: context?.traceId || 'trace-transfer' };
      },
      afterWrapperInvoke: () => undefined,
    });
    runtime.start();
    const worker = new scope.Worker('/worker.js');
    const buffer = Uint8Array.from([1, 2, 3, 4]).buffer;

    worker.postMessage(buffer, [buffer]);

    expect(buffer.byteLength).toBe(0);
    expect(worker.sent[0]).toBeInstanceOf(ArrayBuffer);
    expect(emitted.find((event) => event.operation === 'worker.postMessage')).toMatchObject({
      byteLength: 4,
      inputs: [expect.objectContaining({ fingerprint: 'bytes:1,2,3,4', byteLength: 4 })],
    });
    runtime.stop();
  });
});
