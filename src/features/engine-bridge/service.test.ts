import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SocketListener = (event: { data?: unknown }) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;
  throwOnSend = false;
  closeInfo?: { code?: number; reason?: string };
  private readonly listeners = new Map<string, SocketListener[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: SocketListener): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    if (this.throwOnSend || this.readyState !== FakeWebSocket.OPEN) throw new Error('socket send failed');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.closeInfo = { code, reason };
    this.emit('close', {});
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }

  receive(message: unknown): void {
    this.emit('message', { data: typeof message === 'string' ? message : JSON.stringify(message) });
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, any>,
  runtimeSession: undefined as Record<string, unknown> | undefined,
  updateStateFailure: undefined as Error | undefined,
  setRuntimeSession: vi.fn(async (_value: unknown) => undefined),
  appendAudit: vi.fn(async (_value: unknown) => undefined),
  pairingCode: vi.fn(async () => '123456'),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      getManifest: () => ({ version: '0.2.0' }),
      getURL: (path = '') => `chrome-extension://fixture-id/${path}`,
      sendMessage: vi.fn(async () => undefined),
      connectNative: vi.fn(),
      lastError: undefined,
    },
  },
}));

vi.mock('@/platform/storage/state', () => ({
  getState: vi.fn(async () => structuredClone(fixture.state)),
  updateState: vi.fn(async (updater: (state: Record<string, any>) => Record<string, any> | Promise<Record<string, any>>) => {
    if (fixture.updateStateFailure) throw fixture.updateStateFailure;
    fixture.state = structuredClone(await updater(structuredClone(fixture.state)));
    return structuredClone(fixture.state);
  }),
  getBridgeRuntimeSession: vi.fn(async () => fixture.runtimeSession),
  setBridgeRuntimeSession: fixture.setRuntimeSession,
}));

vi.mock('@/protocol/capabilities', () => ({
  BRIDGE_CAPABILITIES: [],
  getBridgeCapabilityCatalog: vi.fn(async () => ({ version: 1, capabilities: [] })),
}));

vi.mock('@/features/grants/service', () => ({
  routeCapability: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/features/grants/lifecycle', () => ({
  currentActiveGrant: vi.fn(async () => undefined),
}));
vi.mock('@/features/agent-runtime/service', () => ({
  beginAgentAction: vi.fn(async () => ({ id: 'action-1' })),
  finishAgentAction: vi.fn(async () => undefined),
}));
vi.mock('@/features/diagnostics/audit', () => ({
  appendAuditEvent: fixture.appendAudit,
}));
vi.mock('@/features/diagnostics/metrics', () => ({
  recordBridgeState: vi.fn(),
  recordCapabilityMetric: vi.fn(),
  recordHeartbeat: vi.fn(),
}));
vi.mock('./identity', () => ({
  clearBrowserBridgeIdentity: vi.fn(async () => undefined),
  clientAuthPayload: vi.fn(() => 'client-auth'),
  engineChallengePayload: vi.fn(() => 'engine-challenge'),
  getOrCreateBrowserBridgeIdentity: vi.fn(async () => ({
    publicKey: { kty: 'EC', crv: 'P-256', x: 'browser-x', y: 'browser-y' },
    privateKey: {},
  })),
  pairingVerificationCode: fixture.pairingCode,
  publicKeysEqual: vi.fn((left, right) => JSON.stringify(left) === JSON.stringify(right)),
  randomBridgeNonce: vi.fn(() => 'browser-client-nonce-0123456789'),
  signBridgePayload: vi.fn(async () => 'signature'),
  verifyBridgePayload: vi.fn(async () => true),
}));

vi.stubGlobal('WebSocket', FakeWebSocket);

import {
  BRIDGE_HEARTBEAT_TIMEOUT_MS,
  EngineBridge,
} from './service';
import {
  BRIDGE_CHUNK_TIMEOUT_MS,
  BRIDGE_PROTOCOL_VERSION,
} from '@/protocol/bridge';

const NOW = 4_102_444_800_000;
const enginePublicKey = { kty: 'EC' as const, crv: 'P-256' as const, x: 'engine-x', y: 'engine-y' };

function bridgeConfig(paired = true) {
  return {
    transport: 'websocket' as const,
    nativeHost: 'com.yaklang.browser_agent',
    endpoint: 'ws://127.0.0.1:64333/extension',
    autoConnect: false,
    installationId: 'installation-1',
    pairedEngine: paired ? {
      engineIdentityId: 'engine-identity-1',
      deviceId: 'device-1',
      publicKey: enginePublicKey,
      pairedAt: NOW - 1_000,
    } : undefined,
  };
}

function helloAck() {
  return {
    type: 'hello_ack',
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    version: '1.4.0',
    capabilities: ['test.echo'],
    sessionId: 'session-1',
    engineInstanceId: 'engine-instance-1',
    engineIdentityId: 'engine-identity-1',
    connectionId: 'connection-1',
    resumed: false,
  };
}

async function connect(bridge: EngineBridge): Promise<FakeWebSocket> {
  const pending = bridge.connect(fixture.state.bridge);
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  socket.receive({
    type: 'challenge',
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    engineIdentityId: 'engine-identity-1',
    engineInstanceId: 'engine-instance-1',
    challenge: 'engine-challenge-0123456789',
    signature: 'engine-signature',
    timestamp: Date.now(),
    publicKey: enginePublicKey,
  });
  await vi.advanceTimersByTimeAsync(0);
  socket.receive(helloAck());
  await pending;
  return socket;
}

describe('Engine Bridge transport lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    FakeWebSocket.instances.length = 0;
    fixture.runtimeSession = undefined;
    fixture.updateStateFailure = undefined;
    fixture.state = { bridge: bridgeConfig(true), activeGrant: undefined };
    vi.clearAllMocks();
    fixture.setRuntimeSession.mockResolvedValue(undefined);
    fixture.pairingCode.mockResolvedValue('123456');
  });

  afterEach(() => vi.useRealTimers());

  it('rejects an outgoing request immediately when send races with socket failure', async () => {
    const bridge = new EngineBridge();
    const socket = await connect(bridge);
    socket.throwOnSend = true;

    await expect(bridge.requestEngine('test.echo', { value: 1 }, 60_000))
      .rejects.toMatchObject({ code: 'bridge_disconnected' });

    expect(bridge.getStatus()).toMatchObject({ state: 'error', message: expect.stringContaining('发送失败') });
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('closes a half-open connection and rejects pending calls after missed heartbeats', async () => {
    const bridge = new EngineBridge();
    const socket = await connect(bridge);
    const outgoing = bridge.requestEngine('test.echo', { value: 1 }, 120_000);
    const rejection = expect(outgoing).rejects.toMatchObject({ code: 'bridge_disconnected' });

    await vi.advanceTimersByTimeAsync(BRIDGE_HEARTBEAT_TIMEOUT_MS + 1);

    await rejection;
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(bridge.getStatus()).toMatchObject({
      state: 'error',
      message: expect.stringContaining('心跳'),
    });
  });

  it('accepts only a matching sent heartbeat as liveness evidence', async () => {
    const bridge = new EngineBridge();
    const socket = await connect(bridge);
    const firstPing = JSON.parse(socket.sent.find((item) => JSON.parse(item).type === 'ping')!);

    socket.receive({ type: 'pong', sequence: firstPing.sequence, timestamp: firstPing.timestamp, id: 'wrong-id' });
    await vi.advanceTimersByTimeAsync(30_000);
    socket.receive({ type: 'pong', sequence: firstPing.sequence, timestamp: firstPing.timestamp, id: firstPing.id });
    await vi.advanceTimersByTimeAsync(BRIDGE_HEARTBEAT_TIMEOUT_MS - 1);

    expect(bridge.getStatus().state).toBe('connected');
  });

  it('reconnects after a heartbeat failure when auto-connect is enabled', async () => {
    fixture.state.bridge.autoConnect = true;
    const bridge = new EngineBridge();
    await connect(bridge);

    await vi.advanceTimersByTimeAsync(BRIDGE_HEARTBEAT_TIMEOUT_MS + 3_001);

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(bridge.getStatus().state).toBe('connecting');
    bridge.disconnect();
  });

  it('expires incomplete chunks independently when no later chunk arrives', async () => {
    const bridge = new EngineBridge();
    const socket = await connect(bridge);
    const lastByte = btoa('x');
    for (let index = 0; index < 8; index += 1) {
      socket.receive({
        type: 'chunk',
        transferId: `transfer-${index}`,
        index: 1,
        total: 2,
        originalBytes: 262_145,
        data: lastByte,
      });
    }
    expect((bridge as unknown as { chunks: Map<string, unknown> }).chunks.size).toBe(8);

    await vi.advanceTimersByTimeAsync(BRIDGE_CHUNK_TIMEOUT_MS + 1);

    expect((bridge as unknown as { chunks: Map<string, unknown> }).chunks.size).toBe(0);
    expect(fixture.appendAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'bridge.chunk.expire',
      errorCode: 'chunk_timeout',
    }));
  });

  it('keeps the negotiated connection usable when resumable-session persistence fails', async () => {
    const bridge = new EngineBridge();
    fixture.setRuntimeSession.mockRejectedValueOnce(new Error('session storage unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await connect(bridge);

    expect(bridge.getStatus().state).toBe('connected');
    expect(fixture.appendAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'bridge.session.persist',
      errorCode: 'bridge_session_persist_failed',
    }));
    consoleError.mockRestore();
  });

  it('offers a persisted session only after completing the paired identity challenge', async () => {
    fixture.runtimeSession = {
      sessionId: 'previous-session',
      engineInstanceId: 'previous-instance',
      engineIdentityId: 'engine-identity-1',
      updatedAt: NOW - 1_000,
    };
    const bridge = new EngineBridge();
    const socket = await connect(bridge);
    const auth = socket.sent.map((item) => JSON.parse(item)).find((item) => item.type === 'auth');

    expect(auth).toMatchObject({
      type: 'auth',
      challenge: 'engine-challenge-0123456789',
      resumeSessionId: 'previous-session',
    });
  });

  it('rejects hello_ack before the paired identity challenge is answered', async () => {
    const bridge = new EngineBridge();
    const pending = bridge.connect(fixture.state.bridge);
    const rejection = expect(pending).rejects.toThrow('身份挑战');
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.receive(helloAck());

    await rejection;
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(bridge.getStatus()).toMatchObject({ state: 'error', message: expect.stringContaining('身份挑战') });
  });

  it('rejects handshake immediately when the transport closes before hello_ack', async () => {
    const bridge = new EngineBridge();
    const pending = bridge.connect(fixture.state.bridge);
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.close(1006, 'fixture disconnect');

    await expect(pending).rejects.toThrow('协商完成前断开');
  });

  it('terminates a silent handshake instead of leaving connect pending', async () => {
    const bridge = new EngineBridge();
    const pending = bridge.connect(fixture.state.bridge);
    const rejection = expect(pending).rejects.toThrow('协议协商超过 5 秒');
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();

    await vi.advanceTimersByTimeAsync(5_001);

    await rejection;
    expect(socket.closeInfo).toEqual({ code: 1002, reason: 'handshake timeout' });
    expect(bridge.getStatus()).toMatchObject({
      state: 'error',
      message: expect.stringContaining('协议协商超过 5 秒'),
    });
  });

  it('uses the engine pairing deadline locally after pair_pending', async () => {
    fixture.state.bridge = bridgeConfig(false);
    const bridge = new EngineBridge();
    const pending = bridge.startPairing();
    await Promise.resolve();
    await Promise.resolve();
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.receive({
      type: 'pair_pending',
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: 'pairing-1',
      serverNonce: 'server-nonce-0123456789',
      code: '123456',
      expiresAt: NOW + 1_000,
      engineIdentityId: 'engine-identity-1',
      publicKey: enginePublicKey,
    });
    expect((await pending).state).toBe('pending');

    await vi.advanceTimersByTimeAsync(1_001);

    expect(bridge.getPairingStatus()).toMatchObject({ state: 'expired', requestId: 'pairing-1' });
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('rejects a pending startPairing call when the user cancels it', async () => {
    fixture.state.bridge = bridgeConfig(false);
    const bridge = new EngineBridge();
    const pending = bridge.startPairing();
    await Promise.resolve();
    await Promise.resolve();

    bridge.cancelPairing();

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('rejects pairing immediately when the initial request cannot be sent', async () => {
    fixture.state.bridge = bridgeConfig(false);
    const bridge = new EngineBridge();
    const pending = bridge.startPairing();
    await Promise.resolve();
    await Promise.resolve();
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.throwOnSend = true;
    const rejection = expect(pending).rejects.toThrow('配对申请发送失败');

    socket.open();

    await rejection;
    expect(bridge.getPairingStatus().state).toBe('error');
  });

  it('resolves an engine rejection without waiting for the local handshake timer', async () => {
    fixture.state.bridge = bridgeConfig(false);
    const bridge = new EngineBridge();
    const pending = bridge.startPairing();
    await Promise.resolve();
    await Promise.resolve();
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.receive({ type: 'pair_rejected', requestId: 'pairing-1', message: 'rejected by user' });

    await expect(pending).resolves.toMatchObject({ state: 'rejected', message: 'rejected by user' });
  });

  it('does not claim pairing success when credentials cannot be persisted', async () => {
    fixture.state.bridge = bridgeConfig(false);
    const bridge = new EngineBridge();
    const pending = bridge.startPairing();
    await Promise.resolve();
    await Promise.resolve();
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.receive({
      type: 'pair_pending',
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestId: 'pairing-1',
      serverNonce: 'server-nonce-0123456789',
      code: '123456',
      expiresAt: NOW + 60_000,
      engineIdentityId: 'engine-identity-1',
      publicKey: enginePublicKey,
    });
    await expect(pending).resolves.toMatchObject({ state: 'pending' });
    fixture.updateStateFailure = new Error('storage unavailable');

    socket.receive({
      type: 'pair_approved',
      requestId: 'pairing-1',
      deviceId: 'device-1',
      engineIdentityId: 'engine-identity-1',
      publicKey: enginePublicKey,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.getPairingStatus()).toMatchObject({
      state: 'error',
      message: expect.stringContaining('无法保存'),
    });
  });
});
