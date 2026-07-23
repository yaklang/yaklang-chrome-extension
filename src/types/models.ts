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
  category: 'serializer' | 'canonicalization' | 'request-builder' | 'encoding';
  provider: 'native' | 'axios' | 'page';
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
  documentAvailable: boolean;
  pageUrl?: string;
  recordingId?: string;
  startedAt?: number;
  count: number;
  droppedCount: number;
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

export interface BrowserPageCallableExecutionPolicy {
  resultMode: BrowserPageCallableResultMode;
  timeoutMs: number;
}

export interface BrowserPageCallableTransaction {
  request: {
    method: string;
    url: string;
    expectedDestinations: string[];
  };
  inputMode: 'auto';
  boundaries: Array<'fetch' | 'xhr' | 'beacon' | 'form'>;
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

export interface BrowserDeepCaptureStatus {
  state: BrowserDeepCaptureState;
  target: BrowserTarget;
  matcher?: BrowserDeepCaptureMatcher;
  attachedAt?: number;
  pause?: BrowserDeepCapturePause;
  error?: string;
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
  | 'form.compose';

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

export interface BrowserTransformProfile {
  id: string;
  name: string;
  enabled: boolean;
  target: BrowserTarget;
  origin: string;
  match: {
    methods: string[];
    urlPattern: string;
  };
  request: BrowserTransformDirection;
  response: BrowserTransformDirection;
  failMode: 'closed';
  maxConcurrency: number;
  createdAt: number;
  updatedAt: number;
}

export type BrowserTransformProfileInput = Omit<BrowserTransformProfile, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string;
};

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
  durationMs: number;
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
