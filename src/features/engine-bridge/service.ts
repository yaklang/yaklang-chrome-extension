import { browser } from 'wxt/browser';
import type { BridgeEnvelope } from '@/types/messages';
import type { BridgeConfig, BridgePairingStatus, BridgePublicKey, BridgeStatus } from '@/types/models';
import {
  BRIDGE_CAPABILITIES,
  capabilityVisibleToAgent,
  getBridgeCapabilityCatalog,
} from '@/protocol/capabilities';
import {
  BRIDGE_CHUNK_BYTES, BRIDGE_CHUNK_THRESHOLD_BYTES, BRIDGE_CHUNK_TIMEOUT_MS,
  BRIDGE_MAX_CHUNK_TRANSFERS, BRIDGE_MAX_MESSAGE_BYTES, BRIDGE_PROTOCOL_VERSION, parseBridgeEnvelope,
  parseBridgePairingEnvelope, type BridgePairingEnvelope,
} from '@/protocol/bridge';
import { getBridgeRuntimeSession, getState, setBridgeRuntimeSession, updateState } from '@/platform/storage/state';
import { routeCapability } from '@/features/grants/service';
import { browserInstanceAccess } from '@/features/grants/capability-context';
import { errorCode, ExtensionError, isDeniedErrorCode } from '@/shared/errors';
import { appendAuditEvent } from '@/features/diagnostics/audit';
import { beginAgentAction, finishAgentAction } from '@/features/agent-runtime/service';
import { recordBridgeState, recordCapabilityMetric, recordHeartbeat } from '@/features/diagnostics/metrics';
import {
  clearBrowserBridgeIdentity, clientAuthPayload, engineChallengePayload, getOrCreateBrowserBridgeIdentity,
  pairingVerificationCode, publicKeysEqual, randomBridgeNonce, signBridgePayload, verifyBridgePayload,
} from './identity';

const STATUS_EVENT = 'bridge.status.changed';
const PAIRING_STATUS_EVENT = 'bridge.pairing.status.changed';
const RECONNECT_DELAY = 3_000;
const HEARTBEAT_INTERVAL = 20_000;
export const BRIDGE_HEARTBEAT_TIMEOUT_MS = 45_000;
const HANDSHAKE_TIMEOUT = 5_000;
const MAX_CONCURRENT_REQUESTS = 8;
const ENGINE_REQUEST_TIMEOUT = 10_000;
const MAX_OUTGOING_REQUESTS = 4;

interface OutgoingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof globalThis.setTimeout>;
}

interface ChunkAssembly {
  createdAt: number;
  total: number;
  originalBytes: number;
  parts: Array<Uint8Array | undefined>;
  timer: ReturnType<typeof globalThis.setTimeout>;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return (url.protocol === 'ws:' || url.protocol === 'wss:')
      && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

export class EngineBridge {
  private socket?: WebSocket;
  private nativePort?: Browser.runtime.Port;
  private reconnectTimer?: ReturnType<typeof globalThis.setTimeout>;
  private heartbeatTimer?: ReturnType<typeof globalThis.setInterval>;
  private heartbeatWatchdog?: ReturnType<typeof globalThis.setTimeout>;
  private handshakeTimer?: ReturnType<typeof globalThis.setTimeout>;
  private handshakeResolve?: () => void;
  private handshakeReject?: (error: Error) => void;
  private handshakeChallengeAnswered = false;
  private connectPromise?: Promise<void>;
  private pairingSocket?: WebSocket;
  private pairingTimer?: ReturnType<typeof globalThis.setTimeout>;
  private pairingResolve?: (status: BridgePairingStatus) => void;
  private pairingReject?: (error: Error) => void;
  private pairingContext?: {
    config: BridgeConfig;
    clientNonce: string;
    publicKey: BridgePublicKey;
    privateKey: CryptoKey;
    requestId?: string;
    engineIdentityId?: string;
    enginePublicKey?: BridgePublicKey;
  };
  private readonly inFlight = new Map<string, AbortController>();
  private readonly outgoing = new Map<string, OutgoingRequest>();
  private readonly chunks = new Map<string, ChunkAssembly>();
  private readonly pendingHeartbeats = new Map<number, number>();
  private heartbeatSequence = 0;
  private transportFailureMessage?: string;
  private manuallyClosed = false;
  private status: BridgeStatus = { state: 'disconnected', message: '未连接引擎' };
  private pairingStatus: BridgePairingStatus = { state: 'idle', message: '尚未配对' };

  getStatus(): BridgeStatus {
    return this.status;
  }

  getPairingStatus(): BridgePairingStatus {
    if (this.pairingStatus.state === 'pending'
      && this.pairingStatus.expiresAt
      && this.pairingStatus.expiresAt <= Date.now()) {
      this.expirePairing(this.pairingStatus.requestId);
    }
    return this.pairingStatus;
  }

  emitEvent(method: string, params: unknown): void {
    if (this.status.state !== 'connected') return;
    this.trySend({ type: 'event', method, params });
  }

  requestEngine<T>(method: string, params: unknown, timeoutMs = ENGINE_REQUEST_TIMEOUT): Promise<T> {
    if (this.status.state !== 'connected') return Promise.reject(new ExtensionError('bridge_disconnected', 'Yak 引擎未连接'));
    if (!this.nativePort && this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ExtensionError('bridge_disconnected', 'Yak 引擎连接不可用'));
    }
    if (this.outgoing.size >= MAX_OUTGOING_REQUESTS) {
      return Promise.reject(new ExtensionError('server_busy', `插件到 Yak 的并行请求已达到 ${MAX_OUTGOING_REQUESTS} 个上限`));
    }
    if (this.status.capabilities && !this.status.capabilities.includes(method)) {
      return Promise.reject(new ExtensionError('engine_capability_unavailable', `Yak 引擎不支持能力: ${method}`));
    }
    const id = `extension-${crypto.randomUUID()}`;
    return new Promise<T>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.outgoing.delete(id);
        this.trySend({ type: 'cancel', id });
        reject(new ExtensionError('engine_timeout', `Yak 引擎请求超过 ${timeoutMs}ms`));
      }, timeoutMs);
      this.outgoing.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        this.send({ type: 'request', id, method, params });
      } catch (error) {
        globalThis.clearTimeout(timer);
        this.outgoing.delete(id);
        const failure = error instanceof Error ? error : new Error(String(error));
        this.failTransport(failure.message);
        reject(failure);
      }
    });
  }

  async connect(config?: BridgeConfig): Promise<void> {
    if (this.status.state === 'connected' && this.transportAvailable()) return;
    if (this.status.state === 'connected') {
      this.stopHeartbeat();
      this.abortInFlight();
      this.rejectOutgoing(new ExtensionError('bridge_disconnected', 'Bridge 传输已经失效'));
      this.setStatus({ state: 'disconnected', message: 'Bridge 传输已经失效，正在重新连接' });
    }
    if (this.connectPromise) return this.connectPromise;
    const effectiveConfig = config || (await getState()).bridge;
    if (!effectiveConfig.pairedEngine) throw new Error('浏览器插件尚未与 Yak 引擎配对');
    const attempt = (effectiveConfig.transport === 'native'
      ? this.connectNative(effectiveConfig)
      : this.connectWebSocket(effectiveConfig)).catch((error) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!this.manuallyClosed && this.status.state !== 'error') this.setStatus({ state: 'error', message: failure.message });
      throw failure;
    });
    const tracked = attempt.finally(() => {
      if (this.connectPromise === tracked) this.connectPromise = undefined;
    });
    this.connectPromise = tracked;
    return tracked;
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.transportFailureMessage = undefined;
    if (this.reconnectTimer) globalThis.clearTimeout(this.reconnectTimer);
    this.failHandshake(new Error('Bridge 连接已取消'));
    this.stopHeartbeat();
    this.abortInFlight();
    this.rejectOutgoing(new ExtensionError('bridge_disconnected', 'Bridge 已断开'));
    this.socket?.close(1000, 'user disconnected');
    this.socket = undefined;
    this.nativePort?.disconnect();
    this.nativePort = undefined;
    this.setStatus({ state: 'disconnected', message: '已手动断开' });
  }

  cancelActiveRequests(): void {
    this.abortInFlight();
  }

  private async connectWebSocket(config: BridgeConfig): Promise<void> {
    if (!isLoopbackEndpoint(config.endpoint)) {
      throw new Error('Bridge 仅允许连接本机 ws://127.0.0.1、localhost 或 ::1');
    }
    this.manuallyClosed = false;
    this.transportFailureMessage = undefined;
    this.setStatus({ state: 'connecting', message: '正在连接本地 Yak 引擎' });
    const socket = new WebSocket(config.endpoint);
    this.socket = socket;
    const negotiated = this.createHandshakePromise();

    socket.addEventListener('open', () => this.setStatus({ state: 'negotiating', message: '正在验证 Yak 引擎与浏览器身份' }));
    socket.addEventListener('message', (event) => {
      if (this.socket === socket) void this.onMessage(String(event.data));
    });
    socket.addEventListener('error', () => {
      if (this.socket !== socket) return;
      const error = new Error('Bridge 连接失败');
      if (this.status.state === 'connected') {
        this.failTransport(error.message);
        return;
      }
      this.failHandshake(error);
      this.setStatus({ state: 'error', message: error.message });
      try { socket.close(1011, 'websocket error'); } catch { /* The handshake is already terminal. */ }
    });
    socket.addEventListener('close', () => {
      const ownsSocket = this.socket === socket;
      if (!ownsSocket) return;
      const transportFailure = this.transportFailureMessage
        || (this.status.state === 'error' ? this.status.message : undefined);
      this.stopHeartbeat();
      this.socket = undefined;
      this.transportFailureMessage = undefined;
      this.abortInFlight();
      this.rejectOutgoing(new ExtensionError('bridge_disconnected', '与 Yak 引擎的连接已断开'));
      this.failHandshake(new Error('Bridge 在协议协商完成前断开'));
      if (!this.manuallyClosed) this.setStatus({
        state: transportFailure ? 'error' : 'disconnected',
        message: transportFailure || '与 Yak 引擎的连接已断开',
      });
      if (!this.manuallyClosed && config.autoConnect) this.scheduleReconnect(config);
    });
    return negotiated;
  }

  private async connectNative(config: BridgeConfig): Promise<void> {
    if (!config.nativeHost.trim()) throw new Error('Native Messaging Host 名称不能为空');
    this.manuallyClosed = false;
    this.transportFailureMessage = undefined;
    this.setStatus({ state: 'connecting', message: '正在连接 Yakit Native Host' });
    const port = browser.runtime.connectNative(config.nativeHost.trim());
    this.nativePort = port;
    const negotiated = this.createHandshakePromise();
    port.onMessage.addListener((message) => {
      if (this.nativePort === port) void this.onMessage(message);
    });
    port.onDisconnect.addListener(() => {
      const lastError = browser.runtime.lastError?.message;
      const ownsPort = this.nativePort === port;
      if (!ownsPort) return;
      const transportFailure = this.transportFailureMessage
        || (this.status.state === 'error' ? this.status.message : undefined);
      this.nativePort = undefined;
      this.transportFailureMessage = undefined;
      this.abortInFlight();
      this.rejectOutgoing(new ExtensionError('bridge_disconnected', 'Native Host 已断开'));
      this.failHandshake(new Error(lastError || 'Native Host 在协议协商完成前断开'));
      this.stopHeartbeat();
      this.setStatus({
        state: lastError || transportFailure ? 'error' : 'disconnected',
        message: lastError || transportFailure || 'Native Host 已断开',
      });
      if (!this.manuallyClosed && config.autoConnect) this.scheduleReconnect(config);
    });
    this.setStatus({ state: 'negotiating', message: '正在验证 Yak 引擎与浏览器身份' });
    return negotiated;
  }

  private async answerChallenge(config: BridgeConfig, challenge: BridgeEnvelope): Promise<void> {
    const paired = config.pairedEngine;
    if (!paired || !challenge.publicKey || !challenge.engineIdentityId || !challenge.engineInstanceId || !challenge.challenge || !challenge.signature || !challenge.timestamp) {
      throw new Error('Yak 引擎返回了不完整的身份挑战');
    }
    if (Math.abs(Date.now() - challenge.timestamp) > 60_000) throw new Error('Yak 引擎身份挑战已经过期');
    if (paired.engineIdentityId !== challenge.engineIdentityId || !publicKeysEqual(paired.publicKey, challenge.publicKey)) {
      throw new Error('Yak 引擎身份与首次配对记录不一致');
    }
    const verified = await verifyBridgePayload(challenge.publicKey, engineChallengePayload({
      engineIdentityId: challenge.engineIdentityId,
      engineInstanceId: challenge.engineInstanceId,
      challenge: challenge.challenge,
      timestamp: challenge.timestamp,
    }), challenge.signature);
    if (!verified) throw new Error('Yak 引擎身份签名验证失败');
    const [state, previousSession] = await Promise.all([getState(), getBridgeRuntimeSession()]);
    const identity = await getOrCreateBrowserBridgeIdentity(config.installationId);
    const capabilityCatalog = await getBridgeCapabilityCatalog();
    const auth: BridgeEnvelope = {
      type: 'auth',
      client: 'yakit-browser-extension',
      version: browser.runtime.getManifest().version,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      capabilities: [...BRIDGE_CAPABILITIES],
      capabilityCatalog,
      installationId: config.installationId,
      managedInstance: state.bridge.managedInstance,
      taskId: state.activeGrant?.taskId,
      grantId: state.activeGrant?.id,
      resumeSessionId: previousSession?.sessionId,
      challenge: challenge.challenge,
    };
    auth.signature = await signBridgePayload(identity.privateKey, clientAuthPayload({
      origin: browser.runtime.getURL('').replace(/\/$/, ''),
      engineIdentityId: challenge.engineIdentityId,
      engineInstanceId: challenge.engineInstanceId,
      challenge: challenge.challenge,
      envelope: auth,
    }));
    this.send(auth);
    this.handshakeChallengeAnswered = true;
  }

  private createHandshakePromise(): Promise<void> {
    this.failHandshake(new Error('Bridge 协议协商已被新连接替代'));
    this.handshakeChallengeAnswered = false;
    return new Promise<void>((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;
      this.handshakeTimer = globalThis.setTimeout(() => {
        const error = new Error(`Bridge 协议协商超过 ${HANDSHAKE_TIMEOUT / 1_000} 秒`);
        this.failHandshake(error);
        this.setStatus({ state: 'error', message: error.message });
        this.socket?.close(1002, 'handshake timeout');
        this.nativePort?.disconnect();
      }, HANDSHAKE_TIMEOUT);
    });
  }

  private async completeHandshake(message: BridgeEnvelope): Promise<void> {
    if (!this.handshakeResolve) return;
    if (!this.handshakeChallengeAnswered) {
      const error = new Error('Bridge 在完成身份挑战前返回了连接确认');
      this.failHandshake(error);
      this.setStatus({ state: 'error', message: error.message });
      try { this.socket?.close(1008, 'authentication required'); } catch { /* The handshake is already terminal. */ }
      try { this.nativePort?.disconnect(); } catch { /* The handshake is already terminal. */ }
      return;
    }
    if (this.handshakeTimer) globalThis.clearTimeout(this.handshakeTimer);
    const resolve = this.handshakeResolve;
    this.handshakeTimer = undefined;
    this.handshakeResolve = undefined;
    this.handshakeReject = undefined;
    this.setStatus({
      state: 'connected',
      message: '已连接 Yak 引擎',
      connectedAt: Date.now(),
      engineVersion: message.version,
      protocolVersion: message.protocolVersion,
      capabilities: message.capabilities,
      sessionId: message.sessionId,
      engineInstanceId: message.engineInstanceId,
      engineIdentityId: message.engineIdentityId,
      connectionId: message.connectionId,
      taskId: message.taskId,
      grantId: message.grantId,
      resumed: message.resumed,
    });
    this.heartbeatSequence = 0;
    this.startHeartbeat();
    resolve();
    void setBridgeRuntimeSession({
      sessionId: message.sessionId!,
      engineInstanceId: message.engineInstanceId!,
      engineIdentityId: message.engineIdentityId,
      taskId: message.taskId,
      grantId: message.grantId,
      updatedAt: Date.now(),
    }).catch((error) => {
      console.error('Bridge resumable session persistence failed', error);
      void appendAuditEvent({
        category: 'bridge',
        action: 'bridge.session.persist',
        outcome: 'error',
        errorCode: 'bridge_session_persist_failed',
        summary: (error instanceof Error ? error.message : String(error)).slice(0, 512),
      });
    });
  }

  private failHandshake(error: Error): void {
    if (this.handshakeTimer) globalThis.clearTimeout(this.handshakeTimer);
    const reject = this.handshakeReject;
    this.handshakeTimer = undefined;
    this.handshakeResolve = undefined;
    this.handshakeReject = undefined;
    this.handshakeChallengeAnswered = false;
    reject?.(error);
  }

  private async onMessage(raw: unknown): Promise<void> {
    let message: BridgeEnvelope;
    try {
      message = parseBridgeEnvelope(raw);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (this.status.state === 'negotiating') {
        this.failHandshake(failure);
        this.setStatus({ state: 'error', message: failure.message });
        this.socket?.close(1002, 'invalid handshake');
        this.nativePort?.disconnect();
      }
      return;
    }
    if (message.type === 'chunk') {
      try {
        const assembled = this.acceptChunk(message);
        if (assembled !== undefined) await this.onMessage(assembled);
      } catch (error) {
        this.setStatus({ ...this.status, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (message.type === 'challenge') {
      try {
        await this.answerChallenge((await getState()).bridge, message);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.failHandshake(failure);
        this.setStatus({ state: 'error', message: failure.message });
        this.socket?.close(1008, 'identity verification failed');
        this.nativePort?.disconnect();
      }
      return;
    }
    if (message.type === 'hello_ack') {
      await this.completeHandshake(message);
      return;
    }
    if (message.type === 'response' && message.error && this.status.state === 'negotiating') {
      const error = new Error(message.error.message || 'Bridge 拒绝连接');
      this.failHandshake(error);
      this.setStatus({ state: 'error', message: error.message });
      return;
    }
    if (message.type === 'response' && message.id) {
      const pending = this.outgoing.get(message.id);
      if (!pending) return;
      globalThis.clearTimeout(pending.timer);
      this.outgoing.delete(message.id);
      if (message.error) pending.reject(new ExtensionError(
        message.error.code,
        message.error.message,
        message.error.data,
      ));
      else pending.resolve(message.result);
      return;
    }
    if (message.type === 'ping') {
      this.trySend({
        type: 'pong', id: message.id, sequence: message.sequence,
        timestamp: message.timestamp, replyTimestamp: Date.now(),
      });
      return;
    }
    if (message.type === 'pong') {
      const now = Date.now();
      const sequence = Number(message.sequence);
      const sentAt = this.pendingHeartbeats.get(sequence);
      if (sentAt === undefined
        || message.id !== `heartbeat-${sequence}`
        || Number(message.timestamp) !== sentAt) return;
      for (const sequence of this.pendingHeartbeats.keys()) {
        if (sequence <= Number(message.sequence)) this.pendingHeartbeats.delete(sequence);
      }
      const latencyMs = Math.max(0, now - sentAt);
      recordHeartbeat(latencyMs);
      this.armHeartbeatWatchdog();
      this.setStatus({
        ...this.status,
        heartbeatSequence: message.sequence,
        latencyMs,
        lastHeartbeatAt: now,
      });
      return;
    }
    if (message.type === 'cancel' && message.id) {
      this.inFlight.get(message.id)?.abort();
      return;
    }
    if (this.status.state !== 'connected' || message.type !== 'request' || !message.id || !message.method) return;

    if (this.inFlight.size >= MAX_CONCURRENT_REQUESTS) {
      this.trySend({
        type: 'response',
        id: message.id,
        error: { code: 'server_busy', message: `Bridge 并行请求已达到 ${MAX_CONCURRENT_REQUESTS} 个上限` },
      });
      void appendAuditEvent({
        category: 'capability', action: message.method, outcome: 'denied', errorCode: 'server_busy',
        targetTabId: typeof (message.params as { tabId?: unknown } | undefined)?.tabId === 'number'
          ? (message.params as { tabId: number }).tabId
          : undefined,
      });
      return;
    }
    if (this.inFlight.has(message.id)) {
      this.trySend({
        type: 'response', id: message.id,
        error: { code: 'duplicate_request_id', message: 'Bridge 请求 ID 正在使用中' },
      });
      return;
    }

    const controller = new AbortController();
    this.inFlight.set(message.id, controller);
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new ExtensionError('cancelled', 'Bridge 请求已取消')), { once: true });
    });
    const startedAt = performance.now();
    let taskId: string | undefined;
    let actionId: string | undefined;
    let targetTabId = typeof (message.params as { tabId?: unknown } | undefined)?.tabId === 'number'
      ? (message.params as { tabId: number }).tabId
      : undefined;

    try {
      const grant = await browserInstanceAccess('browser.tabs.read');
      taskId = grant.taskId;
      if (capabilityVisibleToAgent(message.method)) {
        actionId = (await beginAgentAction(grant, {
          requestId: message.id,
          method: message.method,
          targetTabId,
        })).id;
      }
      const operation = routeCapability(message.method, message.params, (method, params) => this.requestEngine(method, params));
      const result = await Promise.race([operation, cancelled]);
      const durationMs = performance.now() - startedAt;
      if (!this.trySend({ type: 'response', id: message.id, result })) {
        throw new ExtensionError('bridge_disconnected', '能力执行完成，但 Bridge 响应通道已经断开');
      }
      if (actionId) void finishAgentAction(actionId, 'success');
      recordCapabilityMetric(message.method, durationMs, false);
      void appendAuditEvent({
        category: 'capability', action: message.method, outcome: 'success', taskId,
        targetTabId, durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      });
    } catch (error) {
      const code = errorCode(error);
      recordCapabilityMetric(message.method, performance.now() - startedAt, true);
      this.trySend({
        type: 'response',
        id: message.id,
        error: { code, message: error instanceof Error ? error.message : String(error) },
      });
      if (actionId) {
        void finishAgentAction(
          actionId,
          code === 'cancelled' ? 'cancelled' : isDeniedErrorCode(code) ? 'denied' : 'error',
          code,
        );
      }
      void appendAuditEvent({
        category: 'capability', action: message.method,
        outcome: code === 'cancelled' ? 'cancelled' : isDeniedErrorCode(code) ? 'denied' : 'error',
        taskId, targetTabId, errorCode: code,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      });
    } finally {
      this.inFlight.delete(message.id);
    }
  }

  private send(message: BridgeEnvelope): void {
    let encoded = JSON.stringify(message);
    if (new TextEncoder().encode(encoded).byteLength > BRIDGE_MAX_MESSAGE_BYTES) {
      if (message.type !== 'response' || !message.id) throw new Error('Bridge 出站消息超过 16 MiB 限制');
      encoded = JSON.stringify({
        type: 'response',
        id: message.id,
        error: { code: 'payload_too_large', message: 'Bridge 响应超过 16 MiB 限制' },
      } satisfies BridgeEnvelope);
    }
    const bytes = new TextEncoder().encode(encoded);
    if (bytes.byteLength > BRIDGE_CHUNK_THRESHOLD_BYTES) {
      const transferId = `chunk-${crypto.randomUUID()}`;
      const total = Math.ceil(bytes.byteLength / BRIDGE_CHUNK_BYTES);
      for (let index = 0; index < total; index += 1) {
        const start = index * BRIDGE_CHUNK_BYTES;
        this.sendRaw(JSON.stringify({
          type: 'chunk', transferId, index, total, originalBytes: bytes.byteLength,
          data: bytesToBase64(bytes.subarray(start, Math.min(start + BRIDGE_CHUNK_BYTES, bytes.byteLength))),
        } satisfies BridgeEnvelope));
      }
      return;
    }
    this.sendRaw(encoded);
  }

  private trySend(message: BridgeEnvelope): boolean {
    try {
      this.send(message);
      return true;
    } catch (error) {
      this.failTransport(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private sendRaw(encoded: string): void {
    if (this.nativePort) {
      try {
        this.nativePort.postMessage(JSON.parse(encoded) as BridgeEnvelope);
        return;
      } catch (error) {
        throw new ExtensionError('bridge_disconnected', `Native Host 发送失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new ExtensionError('bridge_disconnected', 'Bridge WebSocket 已断开');
    }
    try {
      this.socket.send(encoded);
    } catch (error) {
      throw new ExtensionError('bridge_disconnected', `Bridge WebSocket 发送失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private acceptChunk(message: BridgeEnvelope): string | undefined {
    const now = Date.now();
    const transferId = message.transferId!;
    let assembly = this.chunks.get(transferId);
    if (!assembly) {
      if (this.chunks.size >= BRIDGE_MAX_CHUNK_TRANSFERS) throw new Error('Bridge 并行分片传输超过上限');
      assembly = {
        createdAt: now, total: message.total!, originalBytes: message.originalBytes!,
        parts: new Array<Uint8Array | undefined>(message.total!),
        timer: globalThis.setTimeout(() => this.expireChunk(transferId), BRIDGE_CHUNK_TIMEOUT_MS),
      };
      this.chunks.set(transferId, assembly);
    }
    if (assembly.total !== message.total || assembly.originalBytes !== message.originalBytes) {
      this.deleteChunk(transferId);
      throw new Error('Bridge 分片元数据不一致');
    }
    const part = base64ToBytes(message.data!);
    if (part.byteLength > BRIDGE_CHUNK_BYTES || (message.index! < assembly.total - 1 && part.byteLength !== BRIDGE_CHUNK_BYTES)) {
      this.deleteChunk(transferId);
      throw new Error('Bridge 分片大小无效');
    }
    assembly.parts[message.index!] = part;
    if (assembly.parts.some((item) => item === undefined)) return undefined;
    const bytes = new Uint8Array(assembly.originalBytes);
    let offset = 0;
    for (const item of assembly.parts) {
      bytes.set(item!, offset);
      offset += item!.byteLength;
    }
    this.deleteChunk(transferId);
    if (offset !== assembly.originalBytes) throw new Error('Bridge 分片重组大小不匹配');
    return new TextDecoder().decode(bytes);
  }

  private scheduleReconnect(config: BridgeConfig): void {
    if (this.reconnectTimer) globalThis.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = globalThis.setTimeout(() => void this.connect(config).catch(() => undefined), RECONNECT_DELAY);
  }

  private transportAvailable(): boolean {
    return Boolean(this.nativePort || this.socket?.readyState === WebSocket.OPEN);
  }

  private failTransport(message: string): void {
    if (this.manuallyClosed) return;
    const normalized = message.trim() || 'Bridge 传输不可用';
    this.transportFailureMessage = normalized;
    this.stopHeartbeat();
    this.abortInFlight();
    this.rejectOutgoing(new ExtensionError('bridge_disconnected', normalized));
    this.setStatus({ state: 'error', message: normalized });
    try {
      if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
        this.socket.close(1011, 'bridge transport failure');
      }
    } catch { /* The status and pending calls have already failed closed. */ }
    try { this.nativePort?.disconnect(); } catch { /* The status is already terminal. */ }
  }

  private deleteChunk(transferId: string): void {
    const assembly = this.chunks.get(transferId);
    if (!assembly) return;
    globalThis.clearTimeout(assembly.timer);
    this.chunks.delete(transferId);
  }

  private expireChunk(transferId: string): void {
    const assembly = this.chunks.get(transferId);
    if (!assembly) return;
    this.deleteChunk(transferId);
    void appendAuditEvent({
      category: 'bridge',
      action: 'bridge.chunk.expire',
      outcome: 'error',
      errorCode: 'chunk_timeout',
      durationMs: Date.now() - assembly.createdAt,
      summary: `${assembly.parts.filter(Boolean).length}/${assembly.total} 个分片`,
    });
  }

  private clearChunks(): void {
    for (const transferId of [...this.chunks.keys()]) this.deleteChunk(transferId);
  }

  private abortInFlight(): void {
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
    this.clearChunks();
  }

  private rejectOutgoing(error: Error): void {
    for (const pending of this.outgoing.values()) {
      globalThis.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.outgoing.clear();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const ping = () => {
      if (this.status.state !== 'connected') return;
      const sequence = ++this.heartbeatSequence;
      const sentAt = Date.now();
      this.pendingHeartbeats.set(sequence, sentAt);
      while (this.pendingHeartbeats.size > 4) {
        const oldest = this.pendingHeartbeats.keys().next().value;
        if (typeof oldest !== 'number') break;
        this.pendingHeartbeats.delete(oldest);
      }
      if (!this.trySend({ type: 'ping', id: `heartbeat-${sequence}`, sequence, timestamp: sentAt })) {
        this.pendingHeartbeats.delete(sequence);
      }
    };
    this.armHeartbeatWatchdog();
    ping();
    this.heartbeatTimer = globalThis.setInterval(ping, HEARTBEAT_INTERVAL);
  }

  private armHeartbeatWatchdog(): void {
    if (this.heartbeatWatchdog) globalThis.clearTimeout(this.heartbeatWatchdog);
    this.heartbeatWatchdog = globalThis.setTimeout(() => {
      this.heartbeatWatchdog = undefined;
      this.failTransport(`Yak 引擎心跳超过 ${BRIDGE_HEARTBEAT_TIMEOUT_MS / 1_000} 秒未响应`);
    }, BRIDGE_HEARTBEAT_TIMEOUT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) globalThis.clearInterval(this.heartbeatTimer);
    if (this.heartbeatWatchdog) globalThis.clearTimeout(this.heartbeatWatchdog);
    this.heartbeatTimer = undefined;
    this.heartbeatWatchdog = undefined;
    this.pendingHeartbeats.clear();
  }

  private setStatus(status: BridgeStatus): void {
    if (status.state !== this.status.state && ['connecting', 'connected', 'disconnected', 'error'].includes(status.state)) {
      recordBridgeState(status.state as 'connecting' | 'connected' | 'disconnected' | 'error');
    }
    this.status = status;
    void browser.runtime.sendMessage({ action: STATUS_EVENT, payload: status }).catch(() => undefined);
  }

  async startPairing(): Promise<BridgePairingStatus> {
    const config = (await getState()).bridge;
    if (config.pairedEngine) return { state: 'approved', message: '当前浏览器已经完成配对', engineIdentityId: config.pairedEngine.engineIdentityId };
    if (!isLoopbackEndpoint(config.endpoint)) throw new Error('配对仅允许访问本机 Yak Bridge');
    const currentPairing = this.getPairingStatus();
    if (this.pairingSocket && ['requesting', 'pending'].includes(currentPairing.state)) return currentPairing;
    this.cancelPairing(false);
    const identity = await getOrCreateBrowserBridgeIdentity(config.installationId);
    const clientNonce = randomBridgeNonce();
    const pairingURL = new URL(config.endpoint);
    pairingURL.pathname = '/pairing';
    pairingURL.search = '';
    pairingURL.hash = '';
    const socket = new WebSocket(pairingURL.toString());
    this.pairingSocket = socket;
    this.pairingContext = { config, clientNonce, publicKey: identity.publicKey, privateKey: identity.privateKey };
    this.setPairingStatus({ state: 'requesting', message: '正在向本机 Yak 引擎申请配对' });
    const pending = new Promise<BridgePairingStatus>((resolve, reject) => {
      this.pairingResolve = resolve;
      this.pairingReject = reject;
      this.pairingTimer = globalThis.setTimeout(() => {
        const error = new Error('Yak 引擎配对请求超过 5 秒未响应');
        this.failPairing(error);
      }, HANDSHAKE_TIMEOUT);
    });
    socket.addEventListener('open', () => {
      if (this.pairingSocket !== socket) return;
      try {
        socket.send(JSON.stringify({
          type: 'pair_request', protocolVersion: BRIDGE_PROTOCOL_VERSION,
          installationId: config.installationId,
          managedInstance: config.managedInstance,
          client: 'yakit-browser-extension', version: browser.runtime.getManifest().version,
          nonce: clientNonce, publicKey: identity.publicKey,
        } satisfies BridgePairingEnvelope));
      } catch (error) {
        this.failPairing(new Error(`Yak 配对申请发送失败: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    socket.addEventListener('message', (event) => {
      if (this.pairingSocket !== socket) return;
      void this.onPairingMessage(String(event.data)).catch((error) => {
        this.failPairing(error instanceof Error ? error : new Error(String(error)));
      });
    });
    socket.addEventListener('error', () => {
      if (this.pairingSocket === socket) this.failPairing(new Error('无法连接本机 Yak 配对服务'));
    });
    socket.addEventListener('close', () => {
      if (this.pairingSocket !== socket) return;
      this.pairingSocket = undefined;
      if (['requesting', 'pending'].includes(this.pairingStatus.state)) this.failPairing(new Error('Yak 配对连接已断开'));
    });
    return pending;
  }

  cancelPairing(notify = true): BridgePairingStatus {
    if (this.pairingTimer) globalThis.clearTimeout(this.pairingTimer);
    const reject = this.pairingReject;
    this.pairingTimer = undefined;
    this.pairingResolve = undefined;
    this.pairingReject = undefined;
    this.pairingContext = undefined;
    this.pairingSocket?.close(1000, 'pairing cancelled');
    this.pairingSocket = undefined;
    const status: BridgePairingStatus = { state: 'idle', message: '配对已取消' };
    if (notify) this.setPairingStatus(status);
    reject?.(new ExtensionError('cancelled', 'Yak 引擎配对已取消'));
    return status;
  }

  async unpair(): Promise<void> {
    const state = await getState();
    this.disconnect();
    this.cancelPairing(false);
    await clearBrowserBridgeIdentity(state.bridge.installationId);
    await updateState((current) => ({
      ...current,
      bridge: {
        ...current.bridge,
        pairedEngine: undefined,
        autoConnect: false,
      },
    }));
    this.setPairingStatus({ state: 'idle', message: '本地配对凭据已清除，浏览器安装身份保持不变' });
  }

  private async onPairingMessage(raw: unknown): Promise<void> {
    let message: BridgePairingEnvelope;
    try {
      message = parseBridgePairingEnvelope(raw);
    } catch (error) {
      this.failPairing(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const context = this.pairingContext;
    if (!context) return;
    if (message.type === 'pair_pending') {
      const code = await pairingVerificationCode({
        engineIdentityId: message.engineIdentityId!, requestId: message.requestId!,
        origin: browser.runtime.getURL('').replace(/\/$/, ''), installationId: context.config.installationId,
        clientNonce: context.clientNonce, serverNonce: message.serverNonce!, publicKey: context.publicKey,
        managedInstance: context.config.managedInstance,
      });
      if (code !== message.code) {
        this.failPairing(new Error('Yak 配对验证码校验失败'));
        return;
      }
      context.requestId = message.requestId;
      context.engineIdentityId = message.engineIdentityId;
      context.enginePublicKey = message.publicKey;
      if (this.pairingTimer) globalThis.clearTimeout(this.pairingTimer);
      const status: BridgePairingStatus = {
        state: 'pending', message: '请在 Yakit 中确认相同的验证码',
        requestId: message.requestId, code, engineIdentityId: message.engineIdentityId, expiresAt: message.expiresAt,
      };
      this.pairingTimer = globalThis.setTimeout(
        () => this.expirePairing(message.requestId),
        Math.max(0, Number(message.expiresAt) - Date.now()),
      );
      this.setPairingStatus(status);
      this.pairingResolve?.(status);
      this.pairingResolve = undefined;
      this.pairingReject = undefined;
      return;
    }
    if (message.type === 'pair_approved') {
      if (this.pairingStatus.expiresAt && this.pairingStatus.expiresAt <= Date.now()) {
        this.expirePairing(this.pairingStatus.requestId);
        return;
      }
      if (!context.requestId || message.requestId !== context.requestId || !context.engineIdentityId || !context.enginePublicKey
        || message.engineIdentityId !== context.engineIdentityId || !message.publicKey || !publicKeysEqual(message.publicKey, context.enginePublicKey)) {
        this.failPairing(new Error('Yak 配对批准信息与当前申请不一致'));
        return;
      }
      let next: Awaited<ReturnType<typeof updateState>>;
      try {
        next = await updateState((current) => ({
          ...current,
          bridge: {
            ...current.bridge,
            autoConnect: true,
            pairedEngine: {
              engineIdentityId: message.engineIdentityId!, deviceId: message.deviceId!,
              publicKey: message.publicKey!, pairedAt: Date.now(),
            },
          },
        }));
      } catch (error) {
        this.failPairing(new Error(`无法保存 Yak 配对凭据: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      if (this.pairingTimer) globalThis.clearTimeout(this.pairingTimer);
      this.pairingTimer = undefined;
      this.setPairingStatus({ state: 'approved', message: '已与 Yak 引擎安全配对', engineIdentityId: message.engineIdentityId });
      this.pairingContext = undefined;
      const socket = this.pairingSocket;
      this.pairingSocket = undefined;
      socket?.close(1000, 'pairing approved');
      void this.connect(next.bridge).catch(() => undefined);
      return;
    }
    const state = message.type === 'pair_rejected' ? 'rejected' : message.type === 'pair_expired' ? 'expired' : 'error';
    const status: BridgePairingStatus = { state, message: message.message || 'Yak 引擎拒绝了配对申请', requestId: message.requestId };
    if (this.pairingTimer) globalThis.clearTimeout(this.pairingTimer);
    this.pairingTimer = undefined;
    this.setPairingStatus(status);
    this.pairingResolve?.(status);
    this.pairingResolve = undefined;
    this.pairingReject = undefined;
    this.pairingContext = undefined;
    const socket = this.pairingSocket;
    this.pairingSocket = undefined;
    socket?.close(1000, state);
  }

  private expirePairing(requestId?: string): void {
    if (this.pairingStatus.state !== 'pending') return;
    if (requestId && this.pairingStatus.requestId !== requestId) return;
    if (this.pairingTimer) globalThis.clearTimeout(this.pairingTimer);
    this.pairingTimer = undefined;
    const status: BridgePairingStatus = {
      state: 'expired',
      message: 'Yak 引擎配对申请已经过期，请重新发起',
      requestId: this.pairingStatus.requestId,
      engineIdentityId: this.pairingStatus.engineIdentityId,
      expiresAt: this.pairingStatus.expiresAt,
    };
    this.pairingContext = undefined;
    this.setPairingStatus(status);
    const socket = this.pairingSocket;
    this.pairingSocket = undefined;
    socket?.close(1000, 'pairing expired');
  }

  private failPairing(error: Error): void {
    if (this.pairingTimer) globalThis.clearTimeout(this.pairingTimer);
    this.pairingTimer = undefined;
    this.pairingReject?.(error);
    this.pairingResolve = undefined;
    this.pairingReject = undefined;
    this.pairingContext = undefined;
    this.setPairingStatus({ state: 'error', message: error.message });
    const socket = this.pairingSocket;
    this.pairingSocket = undefined;
    try { socket?.close(1000, 'pairing failed'); } catch { /* Status is already terminal. */ }
  }

  private setPairingStatus(status: BridgePairingStatus): void {
    this.pairingStatus = status;
    void browser.runtime.sendMessage({ action: PAIRING_STATUS_EVENT, payload: status }).catch(() => undefined);
  }
}

export const engineBridge = new EngineBridge();
