export type ProxyKind = 'direct' | 'system' | 'fixed_servers' | 'pac_script';
export type ProxyScheme = 'http' | 'https' | 'socks4' | 'socks5';

export interface ProxyProfile {
  id: string;
  name: string;
  kind: ProxyKind;
  host?: string;
  port?: number;
  scheme?: ProxyScheme;
  pacUrl?: string;
  pacScript?: string;
  bypass: string[];
  builtin?: boolean;
  authEnabled?: boolean;
  authUsername?: string;
}

export interface ProxyRule {
  id: string;
  name: string;
  enabled: boolean;
  patterns: string[];
  proxyProfileId: string;
  priority: number;
}

export interface ProxyRoutingSettings {
  defaultProfileId: string;
  failMode: 'open' | 'closed';
}

export interface ProxyRuleStats {
  ruleId: string;
  hits: number;
  lastHitAt?: number;
  lastUrl?: string;
}

export interface ProxyRulePreview {
  url: string;
  matchedRuleIds: string[];
  effectiveRuleId?: string;
  effectiveProfileId: string;
  effectiveProxy: string;
  conflict: boolean;
  conflictProfileIds: string[];
}

export interface ProxyConfiguration {
  version: 1;
  profiles: ProxyProfile[];
  rules: ProxyRule[];
  routing: ProxyRoutingSettings;
}

export interface UserAgentRule {
  id: string;
  name: string;
  enabled: boolean;
  userAgent: string;
  domains: string[];
}

export interface BridgeConfig {
  transport: 'native' | 'websocket';
  nativeHost: string;
  endpoint: string;
  autoConnect: boolean;
  installationId: string;
  pairedEngine?: BridgePairedEngine;
}

export interface BridgePublicKey {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

export interface BridgePairedEngine {
  engineIdentityId: string;
  deviceId: string;
  publicKey: BridgePublicKey;
  pairedAt: number;
}

export type BridgePairingState = 'idle' | 'requesting' | 'pending' | 'approved' | 'rejected' | 'expired' | 'error';

export interface BridgePairingStatus {
  state: BridgePairingState;
  message: string;
  requestId?: string;
  code?: string;
  engineIdentityId?: string;
  expiresAt?: number;
}

export type CapabilityScope =
  | 'browser.tabs.read'
  | 'browser.dom.read'
  | 'browser.dom.write'
  | 'browser.storage.read'
  | 'browser.cookies.read'
  | 'browser.tab.activate'
  | 'browser.page.invoke'
  | 'browser.page.eval.expression'
  | 'browser.page.eval.program'
  | 'browser.human.takeover'
  | 'browser.network.read'
  | 'browser.network.capture'
  | 'browser.network.sensitive.read'
  | 'browser.observation.read'
  | 'browser.observation.control'
  | 'browser.observation.sensitive.read'
  | 'browser.proxy.read'
  | 'browser.proxy.write';

export interface BrowserTarget {
  tabId: number;
  frameId: number;
  documentId?: string;
}

export interface PageFrameSummary extends BrowserTarget {
  parentFrameId: number;
  parentDocumentId?: string;
  url: string;
  origin: string;
  title: string;
  name: string;
  frameType: string;
  documentLifecycle: string;
  isTop: boolean;
  sameOrigin: boolean;
  accessible: boolean;
  sandbox: string[];
}

export interface BridgeGrantTarget extends BrowserTarget {
  origin: string;
  grantedUrl: string;
  title: string;
}

export interface BridgeGrant {
  id: string;
  taskId: string;
  targets: BridgeGrantTarget[];
  scopes: CapabilityScope[];
  createdAt: number;
  expiresAt: number;
}

export type HandoffReason = 'qr_code' | 'mfa' | 'captcha' | 'device_confirmation' | 'other';
export type HandoffState = 'waiting_for_user' | 'completed' | 'cancelled';

export interface HumanHandoff {
  id: string;
  taskId: string;
  target: BridgeGrantTarget;
  reason: HandoffReason;
  message: string;
  state: HandoffState;
  requestedAt: number;
  resolvedAt?: number;
}

export interface AuditEvent {
  id: string;
  timestamp: number;
  category: 'grant' | 'bridge' | 'capability' | 'handoff' | 'settings';
  action: string;
  outcome: 'success' | 'denied' | 'error' | 'cancelled';
  taskId?: string;
  targetTabId?: number;
  durationMs?: number;
  errorCode?: string;
  summary?: string;
}

export type AgentRuntimeState = 'idle' | 'running' | 'paused' | 'waiting_for_human' | 'revoked' | 'expired';
export type AgentActionState = 'running' | 'success' | 'denied' | 'error' | 'cancelled';

export interface AgentActionRecord {
  id: string;
  requestId: string;
  taskId: string;
  grantId: string;
  method: string;
  targetTabId?: number;
  state: AgentActionState;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  errorCode?: string;
}

export interface AgentRuntime {
  state: AgentRuntimeState;
  taskId?: string;
  grantId?: string;
  startedAt?: number;
  pausedAt?: number;
  updatedAt: number;
  actions: AgentActionRecord[];
}

export interface NetworkCaptureOptions {
  captureHeaders: boolean;
  captureBody: boolean;
  maxEntries: number;
  maxBodyBytes: number;
}

export interface NetworkBody {
  encoding: 'utf8' | 'base64';
  data: string;
  byteLength: number;
  truncated: boolean;
  reconstructed?: boolean;
}

export interface NetworkHeader {
  name: string;
  value: string;
}

export interface NetworkRedirect {
  url: string;
  statusCode: number;
  redirectUrl: string;
  timestamp: number;
}

export interface NetworkRequestRecord {
  id: string;
  requestId: string;
  tabId: number;
  frameId: number;
  documentId?: string;
  url: string;
  method: string;
  resourceType: string;
  initiator?: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  statusCode?: number;
  statusLine?: string;
  fromCache?: boolean;
  ip?: string;
  error?: string;
  requestHeadersCaptured: boolean;
  requestBodyCaptured: boolean;
  requestHeaders?: NetworkHeader[];
  responseHeaders?: NetworkHeader[];
  requestBody?: NetworkBody;
  responseContentType?: string;
  responseSize?: number;
  redirects: NetworkRedirect[];
}

export interface NetworkCaptureStatus {
  active: boolean;
  target: BrowserTarget;
  startedAt?: number;
  count: number;
  droppedCount: number;
  options?: NetworkCaptureOptions;
}

export interface NetworkRequestExport {
  id: string;
  url: string;
  isHttps: boolean;
  rawRequest: string;
  rawRequestBase64: string;
  limitations: string[];
}

export type PageObservationKind = 'fetch' | 'xhr' | 'form' | 'websocket' | 'webcrypto' | 'cryptojs';

export interface PageObservationOptions {
  captureValues: boolean;
  maxEntries: number;
  maxValueBytes: number;
  expiresAt?: number;
}

export interface PageObservationRecord {
  id: string;
  sequence: number;
  timestamp: number;
  kind: PageObservationKind;
  operation: string;
  url?: string;
  method?: string;
  algorithm?: string;
  direction?: 'send' | 'receive';
  socketId?: string;
  byteLength?: number;
  resultByteLength?: number;
  dataType?: string;
  stack?: string;
  scriptUrl?: string;
  sensitiveCaptured: boolean;
  inputPreview?: string;
  outputPreview?: string;
  error?: string;
}

export interface PageObservationStatus {
  active: boolean;
  target: BrowserTarget;
  startedAt?: number;
  count: number;
  droppedCount: number;
  options?: PageObservationOptions;
}

export interface YakitFuzzerOpenResult {
  pageId: string;
  tabName: string;
}

export interface YakPocGenerateResult {
  language: 'yak';
  fileName: string;
  code: string;
}

export interface BrowserRequestAnalysisSignal {
  location: 'header' | 'parameter';
  name: string;
  category: 'authorization' | 'csrf' | 'signature' | 'nonce' | 'timestamp' | 'cookie';
}

export interface BrowserRequestAnalysisBundle {
  request: {
    method: string;
    scheme: 'http' | 'https';
    host: string;
    path: string;
    contentType: string;
    queryKeys: string[];
    headerNames: string[];
    cookieNames: string[];
    bodyKeys: string[];
    bodyBytes: number;
  };
  signals: BrowserRequestAnalysisSignal[];
  observations: Array<Pick<PageObservationRecord, 'kind' | 'operation' | 'algorithm' | 'direction' | 'scriptUrl' | 'byteLength' | 'resultByteLength' | 'timestamp'>>;
  valuePolicy: string;
  recommendedChecks: string[];
}

export interface FloatingPanelPreferences {
  enabled: boolean;
  side: 'left' | 'right';
  y: number;
  displayMode: 'always' | 'active-task';
  siteMode: 'all' | 'allowlist' | 'denylist';
  siteOrigins: string[];
  shortcutEnabled: boolean;
  autoCollapseFullscreen: boolean;
}

export type BridgeConnectionState = 'disconnected' | 'connecting' | 'negotiating' | 'connected' | 'error';

export interface BridgeStatus {
  state: BridgeConnectionState;
  message: string;
  connectedAt?: number;
  engineVersion?: string;
  protocolVersion?: number;
  capabilities?: string[];
  sessionId?: string;
  engineInstanceId?: string;
  engineIdentityId?: string;
  connectionId?: string;
  taskId?: string;
  grantId?: string;
  resumed?: boolean;
  heartbeatSequence?: number;
  latencyMs?: number;
  lastHeartbeatAt?: number;
}

export interface BridgeRuntimeSession {
  sessionId: string;
  engineInstanceId: string;
  engineIdentityId?: string;
  taskId?: string;
  grantId?: string;
  updatedAt: number;
}

export interface EnterprisePolicy {
  bridgeTransport?: 'native' | 'websocket';
  bridgeEndpoint?: string;
  nativeHost?: string;
  autoConnect?: boolean;
  disableWebSocket?: boolean;
  floatingPanelEnabled?: boolean;
  maxGrantMinutes?: number;
  grantAllowedOrigins?: string[];
  allowProgramEval?: boolean;
}

export interface EnterprisePolicyStatus {
  managed: boolean;
  policy: EnterprisePolicy;
  warnings: string[];
}

export interface RuntimeMetricAggregate {
  count: number;
  errorCount: number;
  totalDurationMs: number;
  maxDurationMs: number;
}

export interface RuntimeMetrics {
  version: 1;
  firstSeenAt: number;
  updatedAt: number;
  serviceWorkerStarts: number;
  bridgeConnectAttempts: number;
  bridgeConnections: number;
  bridgeDisconnects: number;
  bridgeErrors: number;
  heartbeatSamples: number;
  heartbeatLatencyTotalMs: number;
  heartbeatLatencyMaxMs: number;
  capabilities: Record<string, RuntimeMetricAggregate>;
}

export interface DiagnosticsBundle {
  schemaVersion: 1;
  generatedAt: number;
  extension: { version: string; manifestVersion: number; buildChannel: string; permissions: string[] };
  platform: { os: string; arch: string };
  bridge: Omit<BridgeStatus, 'taskId' | 'grantId'>;
  policy: EnterprisePolicyStatus;
  state: {
    proxyProfiles: number;
    proxyRules: number;
    userAgentRules: number;
    floatingPanelEnabled: boolean;
    activeGrant: boolean;
    activeGrantTargets: number;
    activeGrantScopes: CapabilityScope[];
    handoffState?: HandoffState;
  };
  storageDomains: Record<string, boolean>;
  metrics: RuntimeMetrics;
  recentAudit: Array<Pick<AuditEvent, 'timestamp' | 'category' | 'action' | 'outcome' | 'durationMs' | 'errorCode'>>;
}

export interface ExtensionState {
  version: 7;
  proxyProfiles: ProxyProfile[];
  proxyRules: ProxyRule[];
  proxyRouting: ProxyRoutingSettings;
  activeProxyId: string;
  userAgentRules: UserAgentRule[];
  bridge: BridgeConfig;
  floatingPanel: FloatingPanelPreferences;
  activeGrant?: BridgeGrant;
  handoff?: HumanHandoff;
}

export interface ActiveTabInfo {
  id: number;
  windowId: number;
  title: string;
  url: string;
  favIconUrl?: string;
  lastAccessed?: number;
}

export interface PageContextOptions {
  includeStorage?: boolean;
  includeCookies?: boolean;
  includeDom?: boolean;
}

export interface PageNodeReference {
  captureId: string;
  nodeId: string;
  tabId: number;
  frameId: number;
  documentId?: string;
}

export interface PageNodeSummary {
  nodeId: string;
  semanticKey: string;
  tag: string;
  role: string;
  type: string;
  name: string;
  text: string;
  accessibleName: string;
  selectorHint: string;
  visible: boolean;
  disabled: boolean;
  required: boolean;
  checked?: boolean;
  href?: string;
  placeholder?: string;
  autocomplete?: string;
  shadowDepth: number;
}

export interface PageFormSummary {
  nodeId: string;
  semanticKey: string;
  action: string;
  method: string;
  name: string;
  fieldNodeIds: string[];
}

export interface PageStorageEntry {
  key: string;
  value: string;
  byteLength: number;
  authRelated: boolean;
  truncated: boolean;
}

export interface PageStorageSummary {
  supported: boolean;
  entries: PageStorageEntry[];
  totalEntries: number;
  approximateBytes: number;
  truncated: boolean;
  error?: string;
}

export interface IndexedDbStoreSummary {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  count?: number;
  sampleKeys: Array<string | number>;
  truncated: boolean;
  error?: string;
}

export interface IndexedDbDatabaseSummary {
  name: string;
  version: number;
  stores: IndexedDbStoreSummary[];
  truncated: boolean;
  error?: string;
}

export interface BrowserStorageInventory {
  indexedDB: {
    supported: boolean;
    databases: IndexedDbDatabaseSummary[];
    truncated: boolean;
    error?: string;
  };
  cacheStorage: {
    supported: boolean;
    names: string[];
    truncated: boolean;
    error?: string;
  };
}

export interface PageLifecycleEvent {
  id: string;
  kind: 'document' | 'history' | 'fragment';
  tabId: number;
  frameId: number;
  documentId?: string;
  url: string;
  timestamp: number;
  transitionType?: string;
}

export type PageAuthenticationStatus = 'authenticated' | 'unauthenticated' | 'unknown';

export interface PageAuthenticationSignals {
  status: PageAuthenticationStatus;
  confidence: number;
  evidence: string[];
  passwordFieldCount: number;
  cookieNames: string[];
  storageKeys: string[];
}

export interface PageContextChange {
  semanticKey: string;
  tag: string;
  text: string;
  nodeId?: string;
}

export interface PageContextDiff {
  kind: 'initial' | 'unchanged' | 'changed' | 'document_changed';
  fromCaptureId?: string;
  toCaptureId: string;
  changedSections: Array<'capture_options' | 'document' | 'authentication' | 'forms' | 'interactive' | 'storage' | 'cookies'>;
  addedNodes: PageContextChange[];
  removedNodes: PageContextChange[];
  addedStorageKeys: string[];
  removedStorageKeys: string[];
  addedCookieNames: string[];
  removedCookieNames: string[];
}

export type PageNodeAction = 'click' | 'focus' | 'scroll' | 'setValue';

export interface PageNodeDetails extends PageNodeSummary {
  reference: PageNodeReference;
  connected: boolean;
  attributes: Record<string, string>;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface PageNodeActionResult {
  action: PageNodeAction;
  completedAt: number;
  node: PageNodeDetails;
}

export interface PageEvalRequest {
  mode: 'expression' | 'program';
  code: string;
  tabId?: number;
  frameId?: number;
  documentId?: string;
  timeoutMs?: number;
}

export interface GrantCreateInput {
  targets: Array<{ tabId: number; frameId: number }>;
  scopes: CapabilityScope[];
  durationMinutes: number;
  taskId?: string;
}

export interface PageEvalResult {
  type: string;
  value: unknown;
  preview: string;
  truncated: boolean;
  durationMs: number;
}

export interface PageContext {
  captureId: string;
  capturedAt: number;
  included: { dom: boolean; storage: boolean; cookies: boolean };
  tab: ActiveTabInfo;
  target: BrowserTarget;
  frames: PageFrameSummary[];
  lifecycle: PageLifecycleEvent[];
  authentication: PageAuthenticationSignals;
  diff: PageContextDiff;
  document: {
    title: string;
    url: string;
    referrer: string;
    language: string;
    charset: string;
    readyState: string;
    bodyText: string;
    bodyTextTruncated: boolean;
    headings: Array<{ level: number; text: string }>;
    forms: PageFormSummary[];
    interactive: PageNodeSummary[];
    meta: Record<string, string>;
    localStorage?: PageStorageSummary;
    sessionStorage?: PageStorageSummary;
    storageInventory?: BrowserStorageInventory;
    cryptoCandidates: Array<{ path: string; kind: string }>;
    scannedElementCount: number;
    limitsReached: string[];
  };
  cookies?: BrowserCookie[];
}

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  session: boolean;
  expirationDate?: number;
  hostOnly: boolean;
  storeId: string;
  firstPartyDomain?: string;
  partitionKey?: CookiePartitionKey;
  priority?: 'low' | 'medium' | 'high';
  sameParty?: boolean;
}

export interface CookiePartitionKey {
  topLevelSite?: string;
  hasCrossSiteAncestor?: boolean;
}

export interface CookieInput {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'no_restriction' | 'lax' | 'strict' | 'unspecified';
  expirationDate?: number;
  storeId?: string;
  firstPartyDomain?: string;
  partitionKey?: CookiePartitionKey;
}

export interface CookieRemoveInput {
  url: string;
  name: string;
  storeId?: string;
  firstPartyDomain?: string;
  partitionKey?: CookiePartitionKey;
}

export type CookieTransferFormat = 'json' | 'netscape' | 'set-cookie';

export interface CookieImportResult {
  imported: number;
  failed: number;
  warnings: string[];
}
