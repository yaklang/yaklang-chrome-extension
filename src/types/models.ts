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

export type ProxyConditionType =
  | 'host_exact'
  | 'host_suffix'
  | 'host_wildcard'
  | 'host_regex'
  | 'url_prefix'
  | 'url_wildcard'
  | 'url_regex'
  | 'keyword';

export interface ProxyCondition {
  type: ProxyConditionType;
  value: string;
}

export interface ProxyRule {
  id: string;
  name: string;
  enabled: boolean;
  condition: ProxyCondition;
  proxyProfileId: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProxyRoutingSettings {
  defaultProfileId: string;
  failMode: 'open' | 'closed';
}

export type ProxyRuleSourceFormat = 'auto' | 'autoproxy' | 'switchyomega' | 'hosts';
export type ProxyRuleSourceStatus = 'idle' | 'updating' | 'ready' | 'error';

export interface ProxyRuleSource {
  id: string;
  name: string;
  url: string;
  format: ProxyRuleSourceFormat;
  enabled: boolean;
  matchProfileId: string;
  bypassProfileId: string;
  order: number;
  updateIntervalMinutes: number;
  revision?: string;
  contentHash?: string;
  etag?: string;
  lastModified?: string;
  lastCheckedAt?: number;
  lastUpdatedAt?: number;
  status: ProxyRuleSourceStatus;
  totalRuleCount: number;
  supportedRuleCount: number;
  ignoredRuleCount: number;
  invalidRuleCount: number;
  error?: string;
}

export interface ProxyRuleSourceInput {
  id?: string;
  name: string;
  url: string;
  format: ProxyRuleSourceFormat;
  enabled: boolean;
  matchProfileId: string;
  bypassProfileId: string;
  order?: number;
  updateIntervalMinutes: number;
}

export interface NormalizedProxyRule {
  sourceId: string;
  ordinal: number;
  condition: ProxyCondition;
  exception: boolean;
  raw: string;
  resultProfileName?: string;
}

export interface ProxyRuleParseDiagnostics {
  detectedFormat: Exclude<ProxyRuleSourceFormat, 'auto'>;
  total: number;
  supported: number;
  ignored: number;
  invalid: number;
  warnings: string[];
}

export interface ProxyRulePage {
  sourceId: string;
  revision?: string;
  offset: number;
  limit: number;
  total: number;
  rules: NormalizedProxyRule[];
}

export interface ProxyRuntimeState {
  dirty: boolean;
  compiledBytes: number;
  manualRuleCount: number;
  sourceRuleCount: number;
  appliedAt?: number;
  revision?: string;
  error?: string;
  warnings: string[];
}

export interface ProxyRouteTrace {
  kind: 'manual' | 'source' | 'default';
  name: string;
  condition?: string;
  matched: boolean;
  profileId?: string;
}

export interface ProxyRulePreview {
  url: string;
  hostname: string;
  effectiveProfileId: string;
  effectiveProxy: string;
  matchedKind: 'manual' | 'source' | 'default';
  matchedName: string;
  matchedCondition?: string;
  matchedRuleId?: string;
  matchedSourceId?: string;
  trace: ProxyRouteTrace[];
}

export interface ProxyRuleSourceExport {
  source: ProxyRuleSource;
  content?: string;
}

export interface ProxyConfiguration {
  version: 2;
  profiles: ProxyProfile[];
  rules: ProxyRule[];
  sources: ProxyRuleSourceExport[];
  routing: ProxyRoutingSettings;
}

export type UserAgentProfileCategory = 'desktop' | 'mobile' | 'bot' | 'custom';

export interface UserAgentProfile {
  id: string;
  name: string;
  userAgent: string;
  category: UserAgentProfileCategory;
  builtin: boolean;
}

export interface UserAgentProfileInput {
  id?: string;
  name: string;
  userAgent: string;
}

export interface UserAgentAssignment {
  id: string;
  hostname: string;
  profileId: string;
  createdAt: number;
  updatedAt: number;
}

export interface UserAgentResolution {
  hostname: string;
  mode: 'default' | 'override';
  userAgent: string;
  profile?: UserAgentProfile;
  assignment?: UserAgentAssignment;
}

export interface BridgeConfig {
  transport: 'native' | 'websocket';
  nativeHost: string;
  endpoint: string;
  autoConnect: boolean;
  installationId: string;
  managedInstance?: {
    manager: 'ytray' | 'yakit';
    instanceId: string;
    badge: string;
  };
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

export interface BrowserAuthorizationInstance {
  deviceId: string;
  badge: string;
  current: boolean;
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
  | 'browser.tabs.write'
  | 'browser.isolation.read'
  | 'browser.isolation.manage'
  | 'browser.dom.read'
  | 'browser.dom.write'
  | 'browser.storage.read'
  | 'browser.cookies.read'
  | 'browser.tab.activate'
  | 'browser.instance.close'
  | 'browser.page.invoke'
  | 'browser.page.eval.expression'
  | 'browser.page.eval.program'
  | 'browser.human.takeover'
  | 'browser.network.read'
  | 'browser.network.capture'
  | 'browser.network.sensitive.read'
  | 'browser.network.replay'
  | 'browser.recording.read'
  | 'browser.recording.control'
  | 'browser.recording.sensitive.read'
  | 'browser.callable.execute'
  | 'browser.debugger.read'
  | 'browser.debugger.control'
  | 'browser.transform.read'
  | 'browser.transform.manage'
  | 'browser.transform.execute'
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
  isolationContextId: string;
  cookieStoreId?: string;
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
  isolationContextId?: string;
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
  persistence?: 'pending' | 'persisted' | 'memory-only' | 'degraded';
  persistenceError?: string;
  pendingMutations?: number;
  droppedActionCount?: number;
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
  active?: boolean;
  target: BrowserTarget;
  startedAt?: number;
  count: number;
  droppedCount: number;
  options?: NetworkCaptureOptions;
  retainedBytes?: number;
  globalCount?: number;
  globalRetainedBytes?: number;
  persistence?: 'pending' | 'persisted' | 'memory-only' | 'degraded';
  persistenceError?: string;
}

export interface NetworkRequestExport {
  id: string;
  url: string;
  isHttps: boolean;
  rawRequest: string;
  rawRequestBase64: string;
  limitations: string[];
}

export type BrowserRecordingEventKind =
  | 'interaction'
  | 'fetch'
  | 'xhr'
  | 'form'
  | 'beacon'
  | 'worker'
  | 'message'
  | 'websocket'
  | 'crypto'
  | 'transform'
  | 'navigation';

export type BrowserCryptoFamily = 'symmetric' | 'asymmetric' | 'digest' | 'mac' | 'signature' | 'kdf' | 'key-management' | 'unknown';
export type BrowserCryptoProviderKind = 'native' | 'library' | 'business' | 'wasm' | 'unknown';
export type BrowserCryptoStateModel = 'stateless' | 'receiver' | 'session' | 'stream' | 'async-ready';

export interface BrowserRecordingCrypto {
  adapterId: string;
  providerKind: BrowserCryptoProviderKind;
  family: BrowserCryptoFamily;
  operation: string;
  algorithm?: string;
  mode?: string;
  padding?: string;
  inputEncoding?: BrowserPageCallableValueEncoding;
  outputEncoding?: BrowserPageCallableValueEncoding;
  state?: {
    model: BrowserCryptoStateModel;
    correlationId?: string;
    phase?: 'create' | 'init' | 'update' | 'final' | 'one-shot';
  };
  key?: {
    kind: 'public' | 'private' | 'secret' | 'unknown';
    bits?: number;
    fingerprint?: string;
  };
}

export interface BrowserRecordingNavigation {
  phase: 'started' | 'committed' | 'completed' | 'restored' | 'same-document' | 'failed';
  kind: 'document' | 'history' | 'fragment' | 'reload' | 'back-forward';
  fromUrl?: string;
  toUrl: string;
  sameDocument: boolean;
  transitionType?: string;
  transitionQualifiers?: string[];
  previousDocumentId?: string;
  documentId?: string;
  error?: string;
}

export interface BrowserRecordingTransform {
  adapterId: string;
  providerKind: BrowserCryptoProviderKind;
  category: 'serializer' | 'canonicalization' | 'request-builder' | 'encoding' | 'compression';
  phase?: 'input' | 'output' | 'boundary';
}

export interface BrowserRecordingOptions {
  captureValues: boolean;
  maxEntries: number;
  maxValueBytes: number;
  expiresAt?: number;
}

export interface BrowserRecordingValueEvidence {
  path: string;
  fingerprint: string;
  encoding: 'text' | 'bytes' | 'hex' | 'base64' | 'json';
  byteLength: number;
  preview?: string;
}

export type BrowserRecordingArgumentRole =
  | 'data'
  | 'key'
  | 'iv'
  | 'algorithm'
  | 'options'
  | 'signature'
  | 'salt'
  | 'nonce'
  | 'aad'
  | 'unknown';

export interface BrowserRecordingCallArgument {
  index: number;
  role: BrowserRecordingArgumentRole;
  dataType: string;
  byteLength?: number;
  replaceable: boolean;
  retained: boolean;
  summary?: string;
}

export interface BrowserRecordingEvent {
  id: string;
  sequence: number;
  timestamp: number;
  durationMs?: number;
  recordingId: string;
  traceId: string;
  interactionId?: string;
  parentEventId?: string;
  kind: BrowserRecordingEventKind;
  source?: 'page' | 'browser';
  documentId?: string;
  operation: string;
  label?: string;
  url?: string;
  method?: string;
  statusCode?: number;
  crypto?: BrowserRecordingCrypto;
  transform?: BrowserRecordingTransform;
  direction?: 'send' | 'receive';
  socketId?: string;
  channelId?: string;
  byteLength?: number;
  resultByteLength?: number;
  dataType?: string;
  stack?: string;
  scriptUrl?: string;
  wrapperHandleId?: string;
  callHandleId?: string;
  callableCapable?: boolean;
  arguments?: BrowserRecordingCallArgument[];
  inputs: BrowserRecordingValueEvidence[];
  outputs: BrowserRecordingValueEvidence[];
  sensitiveCaptured: boolean;
  inputPreview?: string;
  outputPreview?: string;
  error?: string;
  navigation?: BrowserRecordingNavigation;
}

export interface BrowserRecordingStatus {
  active: boolean;
  target: BrowserTarget;
  isolationContextId?: string;
  cookieStoreId?: string;
  documentAvailable: boolean;
  pageUrl?: string;
  recordingId?: string;
  startedAt?: number;
  count: number;
  droppedCount: number;
  budgetDroppedCount?: number;
  previewDroppedCount?: number;
  retentionFloorSequence?: number;
  retainedBytes?: number;
  retainedPreviewBytes?: number;
  retainedCallCount?: number;
  retainedCallBytes?: number;
  retainedCallDroppedCount?: number;
  globalRetainedBytes?: number;
  globalSessionCount?: number;
  persistence?: 'pending' | 'persisted' | 'memory-only' | 'degraded';
  persistenceError?: string;
  options?: BrowserRecordingOptions;
  endedReason?: 'user' | 'expired' | 'authorization';
  navigation?: BrowserRecordingNavigation & {
    eventId?: string;
    timestamp: number;
  };
}

export interface BrowserRecordingLink {
  id: string;
  traceId: string;
  kind: 'value' | 'channel' | 'state';
  fromEventId: string;
  fromPath: string;
  toEventId: string;
  toPath: string;
  confidence: 'exact' | 'correlated';
}

export interface BrowserRecordingTrace {
  id: string;
  interactionId?: string;
  label: string;
  startedAt: number;
  endedAt: number;
  eventIds: string[];
  requestCount: number;
  cryptoCount: number;
  websocketCount: number;
  messageCount: number;
  navigationCount: number;
  linkedValueCount: number;
}

export type BrowserPageCallableKind = 'recorded-call' | 'business-closure' | 'request-transaction' | 'global-function';
export type BrowserPageCallableValueEncoding = 'auto' | 'utf8' | 'hex' | 'base64' | 'json';
export type BrowserPageCallableResultMode = 'sync' | 'promise' | 'auto';
export type BrowserPageCallableBodyFormat = 'json' | 'form' | 'raw';
export type BrowserPageCallableRequestBoundary = 'fetch' | 'xhr' | 'beacon' | 'form';

export interface BrowserPageCallableExecutionPolicy {
  resultMode: BrowserPageCallableResultMode;
  timeoutMs: number;
}

export interface BrowserPageCallableTransaction {
  version: 2;
  prerequisites: Array<{
    boundary: 'fetch';
    method: string;
    url: string;
    requestBodyFormat: BrowserPageCallableBodyFormat | 'none';
    maxRequestBodyBytes: number;
    response: {
      statusCode: number;
      url: string;
      bodyFormat: BrowserPageCallableBodyFormat;
      maxBodyBytes: number;
      requiredPaths: string[];
    };
  }>;
  request: {
    boundary: BrowserPageCallableRequestBoundary;
    method: string;
    url: string;
    expectedDestinations: string[];
    bodyFormat: BrowserPageCallableBodyFormat;
  };
  inputMode: 'auto';
}

export interface BrowserPageCallableInputSlot {
  id: string;
  name: string;
  index: number;
  role: BrowserRecordingArgumentRole;
  dataType: string;
  required: boolean;
  retained: boolean;
}

export interface BrowserTransformObservedOperation {
  operation: string;
  destination?: string;
  crypto?: BrowserRecordingCrypto;
}

export interface BrowserTransformCallableAnalysis {
  version: 1;
  traceId: string;
  confidence: { score: number; level: 'high' | 'medium' | 'low' };
  flow: string[];
  operations: BrowserTransformObservedOperation[];
  evidence: Array<{
    kind: BrowserProfileInferenceEvidenceKind;
    strength: 'proven' | 'supported';
    label: string;
  }>;
}

export interface BrowserPageCallable {
  id: string;
  name: string;
  kind: BrowserPageCallableKind;
  operation: string;
  algorithm?: string;
  crypto?: BrowserRecordingCrypto;
  origin: string;
  target: BrowserTarget;
  lifecycle: 'document';
  execution: BrowserPageCallableExecutionPolicy;
  inputSlots: BrowserPageCallableInputSlot[];
  output: {
    dataType: string;
    encoding: BrowserPageCallableValueEncoding;
    shape: 'value' | 'envelope';
    paths: string[];
  };
  transaction?: BrowserPageCallableTransaction;
  provenance: {
    recordingId?: string;
    traceId?: string;
    eventId?: string;
    sourceUrl?: string;
    lineNumber?: number;
    functionName?: string;
    businessFrameHints?: BrowserBusinessFrameHint[];
    analysis?: BrowserTransformCallableAnalysis;
  };
  createdAt: number;
}

export interface BrowserPageCallableExecution {
  callableId: string;
  type: string;
  preview: string;
  value: unknown;
  byteLength?: number;
  durationMs: number;
}

export interface BrowserRecordingSnapshot {
  status: BrowserRecordingStatus;
  events: BrowserRecordingEvent[];
  traces: BrowserRecordingTrace[];
  links: BrowserRecordingLink[];
  callables: BrowserPageCallable[];
  profileCandidates: BrowserProfileInferenceCandidate[];
}

export type BrowserProfileInferenceStatus =
  | 'ready'
  | 'capture-required'
  | 'mapping-required'
  | 'insufficient-evidence';

export type BrowserProfileInferenceEvidenceKind =
  | 'request-boundary'
  | 'response-boundary'
  | 'exact-value'
  | 'message-boundary'
  | 'state-sequence'
  | 'transform-lineage'
  | 'callable'
  | 'trace-order'
  | 'heuristic';

export interface BrowserProfileInferenceEvidence {
  id: string;
  kind: BrowserProfileInferenceEvidenceKind;
  strength: 'proven' | 'supported' | 'hypothesis';
  label: string;
  eventIds: string[];
  fromPath?: string;
  toPath?: string;
}

export interface BrowserProfileInferenceMissingStep {
  kind: 'business-callable' | 'input-mapping' | 'output-mapping' | 'request-boundary';
  label: string;
  action: 'capture-business-function' | 'select-input' | 'select-output' | 'record-again';
}

export interface BrowserProfileInferencePipelineNode {
  id: string;
  kind: 'context.read' | 'page.call' | 'output.write';
  label: string;
  source?: string;
  destination?: string;
  callHandleId?: string;
}

export interface BrowserProfileInferenceAIContext {
  valuePolicy: 'metadata-only';
  request: {
    eventId: string;
    method: string;
    url: string;
    bodyFormat?: BrowserPageCallableBodyFormat;
    destination?: string;
    serialization?: BrowserProfileInferenceSerialization;
  };
  source: {
    eventId: string;
    kind: BrowserRecordingEventKind;
    operation: string;
    crypto?: BrowserRecordingCrypto;
    scriptUrl?: string;
    arguments: BrowserRecordingCallArgument[];
  };
  sources: Array<{
    eventId: string;
    operation: string;
    crypto?: BrowserRecordingCrypto;
    destination?: string;
  }>;
  evidenceIds: string[];
  requiredDecision: 'capture-business-callable' | 'map-input' | 'map-output' | 'none';
}

export type BrowserProfileInferenceSerialization =
  | 'raw-body'
  | 'json-field'
  | 'form-field'
  | 'header'
  | 'query';

export interface BrowserProfileInferenceSource {
  eventId: string;
  kind: BrowserRecordingEventKind;
  operation: string;
  crypto?: BrowserRecordingCrypto;
  callHandleId?: string;
  arguments: BrowserRecordingCallArgument[];
  destination?: string;
  serialization?: BrowserProfileInferenceSerialization;
}

export interface BrowserBusinessFrameHint {
  functionName: string;
  url?: string;
  support: number;
  averageDepth: number;
}

export interface BrowserProfileCapturePlan {
  matcherEventId: string;
  frameHints: BrowserBusinessFrameHint[];
  expectedDestinations: string[];
  sourceCount: number;
  transaction?: BrowserPageCallableTransaction;
}

export interface BrowserProfileInferenceCandidate {
  id: string;
  recordingId: string;
  traceId: string;
  target: BrowserTarget;
  direction: 'request' | 'response';
  request: {
    eventId: string;
    method: string;
    url: string;
    bodyFormat?: BrowserPageCallableBodyFormat;
    destination?: string;
    serialization?: BrowserProfileInferenceSerialization;
    mappings: Array<{
      sourceEventId: string;
      destination?: string;
      serialization?: BrowserProfileInferenceSerialization;
    }>;
  };
  source: BrowserProfileInferenceSource;
  sources: BrowserProfileInferenceSource[];
  status: BrowserProfileInferenceStatus;
  confidence: { score: number; level: 'high' | 'medium' | 'low' };
  summary: string;
  flow: string[];
  pipeline: BrowserProfileInferencePipelineNode[];
  evidence: BrowserProfileInferenceEvidence[];
  missing: BrowserProfileInferenceMissingStep[];
  capturePlan?: BrowserProfileCapturePlan;
  aiContext: BrowserProfileInferenceAIContext;
}

export type BrowserDeepCaptureState = 'detached' | 'attached' | 'armed' | 'paused' | 'captured' | 'error';

export type BrowserDeepCaptureMatcher =
  | { kind: 'crypto'; adapterId: string; operation: string; wrapperHandleId: string; scriptUrl?: string; frameHints?: BrowserBusinessFrameHint[] }
  | { kind: 'boundary'; eventKind: 'beacon' | 'worker' | 'message'; operation: string; wrapperHandleId: string; scriptUrl?: string; frameHints?: BrowserBusinessFrameHint[] }
  | { kind: 'request'; urlPattern: string; frameHints?: BrowserBusinessFrameHint[] };

export interface BrowserDeepCaptureVariable {
  name: string;
  type: string;
  subtype?: string;
  preview: string;
  detail?: string;
  detailTruncated?: boolean;
}

export interface BrowserDeepCaptureScope {
  type: 'local' | 'closure' | 'module' | 'block' | 'catch' | 'script' | 'with' | 'wasm-expression-stack';
  name?: string;
  variables: BrowserDeepCaptureVariable[];
}

export interface BrowserDeepCaptureFrame {
  id: string;
  index: number;
  functionName: string;
  scriptId: string;
  url: string;
  sourceMapUrl?: string;
  lineNumber: number;
  columnNumber: number;
  scopes: BrowserDeepCaptureScope[];
  thisPreview: string;
  sourceKind: 'page' | 'extension-hook' | 'library';
  libraryFrame: boolean;
  functionInspection?: {
    resolved: boolean;
    parameterCount?: number;
    parameterNames?: string[];
    riskFlags: Array<'network' | 'dom' | 'navigation' | 'storage'>;
    resolution?: 'frame-name' | 'receiver-method' | 'scope-binding' | 'manual-expression';
    referenceExpression?: string;
    candidateCount?: number;
  };
  businessScore?: number;
  businessReasons?: string[];
}

export interface BrowserDeepCapturePause {
  reason: string;
  pausedAt: number;
  deadline: number;
  collecting?: boolean;
  frames: BrowserDeepCaptureFrame[];
  recommendedFrameId?: string;
  automaticCapture?: {
    state: 'ready' | 'ambiguous' | 'blocked' | 'unavailable';
    strategy?: 'selected-frame' | 'request-transaction';
    frameId?: string;
    reason: string;
    alternativeFrameIds?: string[];
  };
}

export interface BrowserDeepCaptureWorkerTarget {
  targetId: string;
  type: 'worker' | 'shared_worker' | 'service_worker';
  url: string;
  state: 'attached' | 'detached' | 'error';
  scriptCount: number;
  attachedAt: number;
  detachedAt?: number;
  error?: string;
}

export interface BrowserDeepCaptureStatus {
  state: BrowserDeepCaptureState;
  target: BrowserTarget;
  isolationContextId?: string;
  cookieStoreId?: string;
  matcher?: BrowserDeepCaptureMatcher;
  attachedAt?: number;
  pause?: BrowserDeepCapturePause;
  error?: string;
  recovery?: {
    page: 'running' | 'possibly-paused';
    debugger: 'detached' | 'still-attached';
    trigger: string;
  };
  workerTargets?: BrowserDeepCaptureWorkerTarget[];
  workerTargetError?: string;
  boundary?: {
    target: 'main-document';
    sourceMaps: 'metadata-only';
    workers: 'evidence-only' | 'unavailable';
    wasm: 'scope-evidence-only';
  };
}

export type BrowserTransformDirectionName = 'request' | 'response';
export type BrowserTransformValueEncoding = 'auto' | 'text' | 'json' | 'base64';
export type BrowserTransformBuiltinOperation =
  | 'value.literal'
  | 'json.stringify'
  | 'json.parse'
  | 'text.toString'
  | 'url.encode'
  | 'url.decode'
  | 'base64.encode'
  | 'base64.decode'
  | 'hex.encode'
  | 'hex.decode'
  | 'object.pick'
  | 'object.compose'
  | 'form.compose'
  | 'form.serialize';

export interface BrowserTransformNodeReference {
  nodeId: string;
  path?: string;
}

interface BrowserTransformPipelineNodeBase {
  id: string;
  name: string;
}

export type BrowserTransformPipelineNode =
  | (BrowserTransformPipelineNodeBase & {
    kind: 'context.read';
    path: string;
  })
  | (BrowserTransformPipelineNodeBase & {
    kind: 'builtin';
    operation: BrowserTransformBuiltinOperation;
    inputs: BrowserTransformNodeReference[];
    options?: Record<string, unknown>;
  })
  | (BrowserTransformPipelineNodeBase & {
    kind: 'page.call';
    callableId: string;
    arguments: BrowserTransformNodeReference[];
  })
  | (BrowserTransformPipelineNodeBase & {
    kind: 'output.write';
    destination: string;
    source: BrowserTransformNodeReference;
    encoding: BrowserTransformValueEncoding;
  });

export interface BrowserTransformDirection {
  enabled: boolean;
  nodes: BrowserTransformPipelineNode[];
}

export interface BrowserTransformRequestTransactionBinding {
  callableId: string;
  transaction: BrowserPageCallableTransaction;
}

export type BrowserTransformExplanationOwner = 'webfuzzer' | 'extension' | 'page' | 'yak';
export type BrowserTransformExplanationProof = 'configured' | 'observed' | 'supported';
export type BrowserTransformExplanationStageKind =
  | 'input'
  | 'prerequisite'
  | 'page-call'
  | 'builtin'
  | 'output'
  | 'session'
  | 'transport';

export interface BrowserTransformExplanationStage {
  id: string;
  kind: BrowserTransformExplanationStageKind;
  owner: BrowserTransformExplanationOwner;
  proof: BrowserTransformExplanationProof;
  title: string;
  summary: string;
  nodeIds: string[];
  inputPaths: string[];
  outputPaths: string[];
  operations: BrowserTransformObservedOperation[];
  evidence: Array<{
    strength: 'proven' | 'supported';
    label: string;
  }>;
  network?: {
    method: string;
    route: string;
    statusCode?: number;
    requiredPaths: string[];
  };
  source?: {
    functionName?: string;
    url?: string;
    lineNumber?: number;
  };
}

export interface BrowserTransformExplanation {
  version: 1;
  directions: Array<{
    direction: BrowserTransformDirectionName;
    summary: string;
    stages: BrowserTransformExplanationStage[];
  }>;
}

export interface BrowserTransformProfile {
  id: string;
  name: string;
  enabled: boolean;
  target: BrowserTarget;
  isolationContextId: string;
  cookieStoreId?: string;
  origin: string;
  match: {
    methods: string[];
    urlPattern: string;
  };
  request: BrowserTransformDirection;
  response: BrowserTransformDirection;
  failMode: 'closed';
  maxConcurrency: number;
  explanation?: BrowserTransformExplanation;
  requestTransaction?: BrowserTransformRequestTransactionBinding;
  recovery?: BrowserTransformRecoveryPlan;
  createdAt: number;
  updatedAt: number;
}

export type BrowserTransformProfileInput = Omit<
  BrowserTransformProfile,
  'id' | 'isolationContextId' | 'cookieStoreId' | 'explanation' | 'requestTransaction' | 'recovery' | 'createdAt' | 'updatedAt'
> & {
  id?: string;
};

export const BROWSER_TRANSFORM_AGENT_CONTRACT_VERSION = 1 as const;
export const BROWSER_TRANSFORM_RECOVERY_CONTRACT_VERSION = 1 as const;

export type BrowserTransformRecoveryState =
  | 'ready'
  | 'stale'
  | 'capturing'
  | 'validation-required'
  | 'confirmation-required'
  | 'failed';

export interface BrowserTransformRecoveryGuide {
  direction: BrowserTransformDirectionName;
  callableId: string;
  inputPaths: string[];
  resultPath?: string;
  outputKind: 'body' | 'json-field' | 'form-field' | 'header' | 'query';
  outputField: string;
  setFormContentType: boolean;
}

export interface BrowserTransformRecoveryBinding {
  callableId: string;
  name: string;
  kind: BrowserPageCallableKind;
  operation: string;
  nodeIds: Array<{
    direction: BrowserTransformDirectionName;
    nodeId: string;
  }>;
  inputSemantics: Array<{
    id: string;
    name: string;
    index: number;
    role: BrowserRecordingArgumentRole;
    dataType: string;
    required: boolean;
    retained: boolean;
  }>;
  output: {
    dataType: string;
    encoding: BrowserPageCallableValueEncoding;
    shape: 'value' | 'envelope';
    paths: string[];
  };
  guides: BrowserTransformRecoveryGuide[];
  frameHints: BrowserBusinessFrameHint[];
  transaction?: BrowserPageCallableTransaction;
}

export interface BrowserTransformRecoveryCapturePlan {
  kind: 'request';
  method: string;
  url: string;
  urlPattern: string;
  expectedDestinations: string[];
  bodyFormat: BrowserPageCallableBodyFormat;
  frameHints: BrowserBusinessFrameHint[];
  automatic: boolean;
  reason?: string;
}

export interface BrowserTransformRecoveryPending {
  target: BrowserTarget;
  callableId: string;
  callableName: string;
  request: BrowserTransformDirection;
  response: BrowserTransformDirection;
  capturedAt: number;
}

export interface BrowserTransformRecoveryValidation {
  id: string;
  proofLevel: 'execution-only';
  summary: string;
  validatedAt: number;
  expiresAt: number;
}

export interface BrowserTransformRecoveryPlan {
  contractVersion: typeof BROWSER_TRANSFORM_RECOVERY_CONTRACT_VERSION;
  state: BrowserTransformRecoveryState;
  desiredEnabled: boolean;
  boundDocumentId?: string;
  binding: BrowserTransformRecoveryBinding;
  capture: BrowserTransformRecoveryCapturePlan;
  pending?: BrowserTransformRecoveryPending;
  validation?: BrowserTransformRecoveryValidation;
  reason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface BrowserTransformRecoveryValidationResult {
  recovery: BrowserTransformRecoveryPlan;
  execution: BrowserTransformExecution;
}

export interface BrowserTransformValidationDraft {
  contractVersion: typeof BROWSER_TRANSFORM_AGENT_CONTRACT_VERSION;
  id: string;
  profile: BrowserTransformProfileInput;
  proofLevel: 'execution-only' | 'structure' | 'exact';
  comparison?: {
    mode: 'structure' | 'exact';
    equivalent: boolean;
    summary: string;
  };
  createdAt: number;
  expiresAt: number;
}

export interface BrowserPacketComparisonCheck {
  id: 'method' | 'route' | 'query' | 'content-type' | 'body-format' | 'body-shape' | 'body-value' | 'headers';
  status: 'pass' | 'fail' | 'warning';
  label: string;
  actual?: unknown;
  expected?: unknown;
}

export interface BrowserPacketComparison {
  mode: 'structure' | 'exact';
  equivalent: boolean;
  checks: BrowserPacketComparisonCheck[];
  summary: string;
}

export interface BrowserTransformHeader {
  name: string;
  value: string;
}

export interface BrowserTransformPacket {
  method?: string;
  url: string;
  statusCode?: number;
  headers: BrowserTransformHeader[];
  bodyBase64: string;
}

export interface BrowserTransformExecuteInput {
  profileId: string;
  direction: BrowserTransformDirectionName;
  packet: BrowserTransformPacket;
}

export interface BrowserTransformExecution {
  profileId: string;
  direction: BrowserTransformDirectionName;
  url: string;
  bodyBase64: string;
  setHeaders: BrowserTransformHeader[];
  removeHeaders: string[];
  logicalInput: unknown;
  logicalOutput: unknown;
  nodeDurations: Array<{ nodeId: string; durationMs: number }>;
  nodeTrace: Array<{
    nodeId: string;
    kind: BrowserTransformPipelineNode['kind'];
    name: string;
    inputRefs: string[];
    output: BrowserTransformValueSummary;
    durationMs: number;
  }>;
  fieldChanges: Array<{
    path: string;
    change: 'added' | 'removed' | 'changed';
    before?: BrowserTransformValueSummary;
    after?: BrowserTransformValueSummary;
  }>;
  durationMs: number;
}

export interface BrowserTransformValueSummary {
  type: 'null' | 'undefined' | 'boolean' | 'number' | 'string' | 'bytes' | 'array' | 'object';
  byteLength?: number;
  itemCount?: number;
}

export interface BrowserTransformProfileProposalResult {
  profile: BrowserTransformProfileInput;
  proposal: Record<string, unknown>;
  next: string;
}

export interface BrowserTransformProfileValidationResult {
  valid: boolean;
  saveEligible: boolean;
  proofLevel: 'execution-only' | 'structure' | 'exact';
  normalizedProfile: BrowserTransformProfileInput;
  generated: BrowserTransformPacket;
  execution: BrowserTransformExecution;
  comparison?: BrowserPacketComparison;
  validationDraft?: Pick<BrowserTransformValidationDraft, 'contractVersion' | 'id' | 'createdAt' | 'expiresAt'>;
  next: string;
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
  observations: Array<Pick<BrowserRecordingEvent, 'kind' | 'operation' | 'crypto' | 'direction' | 'scriptUrl' | 'byteLength' | 'resultByteLength' | 'timestamp'>>;
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

export interface RuntimeQueueMetric {
  pending: number;
  dropped: number;
  persistenceErrors: number;
  persistence: 'pending' | 'persisted' | 'memory-only' | 'degraded';
  error?: string;
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
  queues: {
    audit: RuntimeQueueMetric;
    metrics: RuntimeQueueMetric;
    agentActions: RuntimeQueueMetric;
  };
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
    proxyRuleSources: number;
    proxySourceRules: number;
    proxyCompiledBytes: number;
    proxyConfigurationDirty: boolean;
    customUserAgentProfiles: number;
    userAgentAssignments: number;
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
  proxyRuleSources: ProxyRuleSource[];
  proxyRouting: ProxyRoutingSettings;
  proxyRuntime: ProxyRuntimeState;
  activeProxyId: string;
  customUserAgentProfiles: UserAgentProfile[];
  userAgentAssignments: UserAgentAssignment[];
  bridge: BridgeConfig;
  floatingPanel: FloatingPanelPreferences;
  activeGrant?: BridgeGrant;
  handoff?: HumanHandoff;
}

export interface ActiveTabInfo {
  id: number;
  windowId: number;
  active?: boolean;
  title: string;
  url: string;
  incognito: boolean;
  cookieStoreId?: string;
  isolationContextId?: string;
  favIconUrl?: string;
  lastAccessed?: number;
}

export type BrowserIsolationLevel = 'strong' | 'conditional' | 'none';

export type BrowserIsolationContextKind =
  | 'browser-profile'
  | 'chrome-incognito-store'
  | 'firefox-container'
  | 'verified-tab-local'
  | 'managed-ephemeral-profile'
  | 'sequential-auth-snapshot';

export type BrowserIsolationGuarantee = 'isolated' | 'shared' | 'verified-tab-local' | 'unknown';

export interface BrowserIsolationContext {
  contextId: string;
  kind: BrowserIsolationContextKind;
  cookieStoreId?: string;
  incognito: boolean;
  containerId?: string;
  containerName?: string;
  containerColor?: string;
  managed?: boolean;
  level: BrowserIsolationLevel;
  guarantees: {
    cookies: BrowserIsolationGuarantee;
    localStorage: BrowserIsolationGuarantee;
    indexedDB: BrowserIsolationGuarantee;
    serviceWorker: BrowserIsolationGuarantee;
    httpAuth: BrowserIsolationGuarantee;
    clientCertificate: BrowserIsolationGuarantee;
  };
  tabIds: number[];
  reasons: string[];
}

export interface BrowserIsolationInspection {
  version: 1;
  inspectedAt: number;
  browser: 'chromium' | 'firefox';
  capabilities: {
    incognitoAccess: 'allowed' | 'denied' | 'unsupported';
    containerTabs: boolean;
    managedProfiles: boolean;
  };
  contexts: BrowserIsolationContext[];
  tabs: ActiveTabInfo[];
}

export interface BrowserIsolationProof {
  version: 1;
  id: string;
  leftContextId: string;
  rightContextId: string;
  leftTabId: number;
  rightTabId: number;
  sameOrigin: boolean;
  cookieStoreRelation: 'different' | 'same' | 'unknown';
  accountEvidenceRelation: 'different' | 'same' | 'unknown';
  requestCredentialRelation: 'different' | 'same' | 'unknown';
  refreshCheck: 'passed' | 'failed' | 'not-required';
  level: BrowserIsolationLevel;
  reasons: string[];
  createdAt: number;
  expiresAt: number;
}

export interface BrowserIncognitoIdentityResult {
  tab: ActiveTabInfo;
  context: BrowserIsolationContext;
}

export interface BrowserFirefoxContainerIdentityResult extends BrowserIncognitoIdentityResult {
  container: {
    cookieStoreId: string;
    name: string;
    color: string;
    managed: true;
  };
}

export interface BrowserFirefoxManagedContainer {
  cookieStoreId: string;
  name: string;
  color: string;
  createdAt: number;
  tabCount: number;
}

export interface BrowserAuthContextHandle {
  version: 1;
  id: string;
  slotId: 'left' | 'right';
  accountLabel?: string;
  deviceId: string;
  installationId: string;
  isolationContextId: string;
  isolationProofId: string;
  cookieStoreId: string;
  origin: string;
  grantId: string;
  target: BrowserTarget & { documentId: string };
  fingerprint: string;
  authentication: {
    status: PageAuthenticationStatus;
    cookieCount: number;
    storageEntryCount: number;
    authCookieNames: string[];
    authStorageKeys: string[];
  };
  createdAt: number;
  expiresAt: number;
}

export interface BrowserAuthContextAttestation {
  version: 1;
  id: string;
  deviceId: string;
  installationId: string;
  isolationContextId: string;
  cookieStoreId: string;
  origin: string;
  grantId: string;
  target: BrowserTarget & { documentId: string };
  fingerprint: string;
  authentication: BrowserAuthContextHandle['authentication'];
  createdAt: number;
  expiresAt: number;
}

export type BrowserAuthorizationFieldCategory =
  | 'authentication'
  | 'csrf'
  | 'signature'
  | 'nonce'
  | 'timestamp'
  | 'resource'
  | 'unknown';

export interface BrowserAuthorizationBaselineField {
  location: 'header' | 'path' | 'query' | 'body';
  path: string;
  valueType: 'string' | 'number' | 'boolean' | 'null' | 'binary';
  byteLength: number;
  valueFingerprint: string;
  category: BrowserAuthorizationFieldCategory;
}

export type BrowserAuthorizationResourceSource = 'wire' | 'logical';

export interface BrowserAuthorizationResourceSelector {
  source: BrowserAuthorizationResourceSource;
  location: 'header' | 'path' | 'query' | 'body';
  path: string;
}

export interface BrowserAuthorizationLogicalRequestBinding {
  version: 1;
  source: 'local-replay-draft';
  baselineId: string;
  profileId: string;
  profileName: string;
  isolationContextId: string;
  cookieStoreId: string;
  target: BrowserTarget & { documentId: string };
  origin: string;
  request: {
    method: string;
    url: string;
    path: string;
    contentType: string;
    protocol?: 'graphql';
    operationFingerprint?: string;
    operationNames?: string[];
    actionFingerprint: string;
    headerNames: string[];
    fields: BrowserAuthorizationBaselineField[];
  };
  outputDestinations: string[];
  validation: {
    proofLevel: 'structure';
    summary: string;
    warnings: string[];
  };
  bindingFingerprint: string;
  profileUpdatedAt: number;
  replayUpdatedAt: number;
  createdAt: number;
  expiresAt: number;
}

export interface BrowserAuthorizationBaseline {
  version: 1;
  id: string;
  deviceId: string;
  installationId: string;
  isolationContextId: string;
  cookieStoreId: string;
  origin: string;
  grantId: string;
  target: BrowserTarget & { documentId: string };
  authContextReference: {
    kind: 'handle' | 'attestation';
    id: string;
  };
  networkRequestId: string;
  request: {
    method: string;
    url: string;
    path: string;
    contentType: string;
    protocol?: 'graphql';
    operationFingerprint?: string;
    operationNames?: string[];
    actionFingerprint: string;
    headerNames: string[];
    fields: BrowserAuthorizationBaselineField[];
  };
  logicalRequest?: BrowserAuthorizationLogicalRequestBinding;
  createdAt: number;
  expiresAt: number;
}

export interface BrowserAuthorizationBaselineCandidate {
  id: string;
  method: string;
  url: string;
  path: string;
  resourceType: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  statusCode?: number;
  error?: string;
  eligible: boolean;
  reasons: string[];
}

export interface BrowserAuthorizationResourceValue {
  version: 1;
  baselineId: string;
  source: BrowserAuthorizationResourceSource;
  location: 'header' | 'path' | 'query' | 'body';
  path: string;
  valueType: 'string' | 'number' | 'boolean';
  byteLength: number;
  valueBase64: string;
  valueFingerprint: string;
  logicalBindingFingerprint?: string;
}

export interface BrowserAuthorizationTransformBinding {
  version: 1;
  baselineId: string;
  profileId: string;
  profileName: string;
  isolationContextId: string;
  cookieStoreId: string;
  target: BrowserTarget & { documentId: string };
  origin: string;
  dynamicPaths: string[];
  bindingFingerprint: string;
  createdAt: number;
  expiresAt: number;
}

export interface BrowserAuthorizationCompiledRequest {
  version: 1;
  baselineId: string;
  selector: BrowserAuthorizationResourceSelector;
  method: string;
  url: string;
  isHttps: boolean;
  rawRequestBase64: string;
  resourceValueFingerprint: string;
  logicalBindingFingerprint?: string;
  packetFingerprint: string;
}

export interface BrowserAuthorizationBaselinePacket {
  version: 1;
  baselineId: string;
  method: string;
  url: string;
  isHttps: boolean;
  rawRequestBase64: string;
  packetFingerprint: string;
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
