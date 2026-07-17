import type {
  ActiveTabInfo,
  AgentRuntime,
  AuditEvent,
  BrowserRequestAnalysisBundle,
  BridgeStatus,
  BridgeConfig,
  BridgePairingStatus,
  BridgePublicKey,
  BrowserCookie,
  CookieInput,
  CookieImportResult,
  CookieRemoveInput,
  CookieTransferFormat,
  ExtensionState,
  EnterprisePolicyStatus,
  DiagnosticsBundle,
  RuntimeMetrics,
  GrantCreateInput,
  NetworkCaptureStatus,
  NetworkRequestExport,
  NetworkRequestRecord,
  PageObservationRecord,
  PageObservationStatus,
  PageContext,
  PageContextOptions,
  PageEvalRequest,
  PageEvalResult,
  PageFrameSummary,
  PageNodeAction,
  PageNodeActionResult,
  PageNodeDetails,
  ProxyProfile,
  ProxyConfiguration,
  ProxyRule,
  ProxyRulePreview,
  ProxyRuleStats,
  ProxyRoutingSettings,
  UserAgentRule,
  YakPocGenerateResult,
  YakitFuzzerOpenResult,
} from './models';

export interface ExtensionRequestMap {
  'state.get': { input: undefined; output: ExtensionState };
  'tab.active': { input: undefined; output: ActiveTabInfo };
  'tab.get': { input: { tabId: number }; output: ActiveTabInfo };
  'tab.list': { input: undefined; output: ActiveTabInfo[] };
  'frame.list': { input: { tabId: number }; output: PageFrameSummary[] };
  'proxy.save': { input: ProxyProfile; output: ExtensionState };
  'proxy.delete': { input: { id: string }; output: ExtensionState };
  'proxy.switch': { input: { id: string }; output: ExtensionState };
  'proxy.rule.save': { input: ProxyRule; output: ExtensionState };
  'proxy.rule.delete': { input: { id: string }; output: ExtensionState };
  'proxy.rules.apply': { input: undefined; output: ExtensionState };
  'proxy.rules.preview': { input: { url: string }; output: ProxyRulePreview };
  'proxy.rules.compile': { input: undefined; output: string };
  'proxy.rules.reorder': { input: { ids: string[] }; output: ExtensionState };
  'proxy.rules.settings': { input: ProxyRoutingSettings; output: ExtensionState };
  'proxy.rules.stats': { input: undefined; output: ProxyRuleStats[] };
  'proxy.rules.stats.clear': { input: undefined; output: undefined };
  'proxy.auth.set': { input: { profileId: string; password: string }; output: { configured: boolean } };
  'proxy.auth.status': { input: { profileId: string }; output: { configured: boolean } };
  'proxy.config.export': { input: undefined; output: ProxyConfiguration };
  'proxy.config.import': { input: { configuration: ProxyConfiguration }; output: ExtensionState };
  'cookie.list': { input: { url: string }; output: BrowserCookie[] };
  'cookie.set': { input: CookieInput; output: BrowserCookie };
  'cookie.remove': { input: CookieRemoveInput; output: undefined };
  'cookie.removeMany': { input: { cookies: CookieRemoveInput[] }; output: { removed: number; failed: number } };
  'cookie.import': { input: { url: string; format: CookieTransferFormat; text: string }; output: CookieImportResult };
  'cookie.export': { input: { url: string; format: CookieTransferFormat; includeValues: boolean }; output: string };
  'ua.save': { input: UserAgentRule; output: ExtensionState };
  'ua.delete': { input: { id: string }; output: ExtensionState };
  'ua.apply': { input: undefined; output: ExtensionState };
  'context.capture': { input: PageContextOptions & { tabId?: number; frameId?: number; documentId?: string }; output: PageContext };
  'context.node.inspect': { input: { captureId: string; nodeId: string; tabId?: number; frameId?: number; documentId?: string }; output: PageNodeDetails };
  'context.node.action': { input: { captureId: string; nodeId: string; action: PageNodeAction; value?: string; tabId?: number; frameId?: number; documentId?: string }; output: PageNodeActionResult };
  'context.invoke': { input: { path: string; args: unknown[]; tabId?: number; frameId?: number; documentId?: string; timeoutMs?: number }; output: PageEvalResult };
  'context.eval': { input: PageEvalRequest; output: PageEvalResult };
  'panel.update': { input: {
    enabled?: boolean; side?: 'left' | 'right'; y?: number;
    displayMode?: 'always' | 'active-task'; siteMode?: 'all' | 'allowlist' | 'denylist'; siteOrigins?: string[];
    shortcutEnabled?: boolean; autoCollapseFullscreen?: boolean;
  }; output: ExtensionState };
  'grant.create': { input: GrantCreateInput; output: ExtensionState };
  'grant.revoke': { input: undefined; output: ExtensionState };
  'handoff.resolve': { input: { id: string; outcome: 'completed' | 'cancelled' }; output: ExtensionState };
  'network.capture.start': { input: { tabId?: number; frameId?: number; documentId?: string; captureHeaders?: boolean; captureBody?: boolean; maxEntries?: number; maxBodyBytes?: number }; output: NetworkCaptureStatus };
  'network.capture.status': { input: { tabId?: number; frameId?: number; documentId?: string }; output: NetworkCaptureStatus };
  'network.capture.list': { input: { tabId?: number; frameId?: number; documentId?: string; limit?: number }; output: NetworkRequestRecord[] };
  'network.capture.clear': { input: { tabId?: number; frameId?: number; documentId?: string }; output: NetworkCaptureStatus };
  'network.capture.stop': { input: { tabId?: number; frameId?: number; documentId?: string }; output: NetworkCaptureStatus };
  'network.capture.export': { input: { id: string; tabId?: number; frameId?: number; documentId?: string }; output: NetworkRequestExport };
  'network.capture.send': { input: { id: string; tabId?: number; frameId?: number; documentId?: string }; output: YakitFuzzerOpenResult };
  'network.capture.poc': { input: { id: string; tabId?: number; frameId?: number; documentId?: string }; output: YakPocGenerateResult };
  'network.capture.analysis': { input: { id: string; tabId?: number; frameId?: number; documentId?: string }; output: BrowserRequestAnalysisBundle };
  'observation.start': { input: { tabId?: number; frameId?: number; documentId?: string; captureValues?: boolean; maxEntries?: number; maxValueBytes?: number }; output: PageObservationStatus };
  'observation.status': { input: { tabId?: number; frameId?: number; documentId?: string }; output: PageObservationStatus };
  'observation.list': { input: { tabId?: number; frameId?: number; documentId?: string; limit?: number }; output: PageObservationRecord[] };
  'observation.clear': { input: { tabId?: number; frameId?: number; documentId?: string }; output: PageObservationStatus };
  'observation.stop': { input: { tabId?: number; frameId?: number; documentId?: string }; output: PageObservationStatus };
  'audit.list': { input: { limit?: number }; output: AuditEvent[] };
  'audit.clear': { input: undefined; output: undefined };
  'agent.runtime.get': { input: undefined; output: AgentRuntime };
  'agent.pause': { input: undefined; output: AgentRuntime };
  'agent.resume': { input: undefined; output: AgentRuntime };
  'agent.actions.clear': { input: undefined; output: AgentRuntime };
  'policy.status': { input: undefined; output: EnterprisePolicyStatus };
  'diagnostics.export': { input: undefined; output: DiagnosticsBundle };
  'metrics.get': { input: undefined; output: RuntimeMetrics };
  'metrics.reset': { input: undefined; output: RuntimeMetrics };
  'bridge.config.save': { input: BridgeConfig; output: ExtensionState };
  'bridge.pair': { input: undefined; output: BridgePairingStatus };
  'bridge.pair.cancel': { input: undefined; output: BridgePairingStatus };
  'bridge.pair.status': { input: undefined; output: BridgePairingStatus };
  'bridge.unpair': { input: undefined; output: ExtensionState };
  'bridge.connect': { input: undefined; output: BridgeStatus };
  'bridge.disconnect': { input: undefined; output: BridgeStatus };
  'bridge.status': { input: undefined; output: BridgeStatus };
}

export type ExtensionAction = keyof ExtensionRequestMap;
export type RequestInput<A extends ExtensionAction> = ExtensionRequestMap[A]['input'];
export type RequestOutput<A extends ExtensionAction> = ExtensionRequestMap[A]['output'];

export type ExtensionRequest = {
  [A in ExtensionAction]: undefined extends RequestInput<A>
    ? { action: A; payload?: RequestInput<A> }
    : { action: A; payload: RequestInput<A> }
}[ExtensionAction];

export interface ExtensionResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
}

export interface BridgeEnvelope {
  id?: string;
  type: 'challenge' | 'auth' | 'hello_ack' | 'request' | 'response' | 'event' | 'cancel' | 'ping' | 'pong' | 'chunk';
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: string; message: string };
  client?: string;
  version?: string;
  protocolVersion?: number;
  capabilities?: string[];
  sessionId?: string;
  taskId?: string;
  grantId?: string;
  installationId?: string;
  engineInstanceId?: string;
  engineIdentityId?: string;
  challenge?: string;
  signature?: string;
  publicKey?: BridgePublicKey;
  connectionId?: string;
  resumeSessionId?: string;
  resumed?: boolean;
  sequence?: number;
  timestamp?: number;
  replyTimestamp?: number;
  transferId?: string;
  index?: number;
  total?: number;
  data?: string;
  originalBytes?: number;
}
