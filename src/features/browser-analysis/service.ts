import { browser } from 'wxt/browser';
import * as v from 'valibot';
import {
  getBrowserRecording,
} from '@/features/browser-recording/service';
import { recordingSnapshotForScope } from '@/features/browser-recording/redaction';
import {
  compileGuidedTransform,
  parseGuidedTransform,
} from '@/features/browser-transform/guided';
import { createBrowserTransformProfileInput } from '@/features/browser-transform/profile-draft';
import { validateBrowserTransformProfile } from '@/features/browser-transform/service';
import { executePageCallable, listPageCallables } from '@/features/page-callable/service';
import { browserTransformProfileInputSchema } from '@/protocol/transform';
import { ExtensionError } from '@/shared/errors';
import { createOpaqueId } from '@/shared/id';
import {
  BROWSER_TRANSFORM_AGENT_CONTRACT_VERSION,
  type ActiveTabInfo,
  type BrowserPageCallable,
  type BrowserPageCallableExecution,
  type BrowserPageCallableTransaction,
  type BrowserPacketComparison,
  type BrowserPacketComparisonCheck,
  type BrowserProfileInferenceCandidate,
  type BrowserRecordingEvent,
  type BrowserRecordingSnapshot,
  type BrowserTarget,
  type BrowserTransformExecution,
  type BrowserTransformHeader,
  type BrowserTransformCallableAnalysis,
  type BrowserTransformPacket,
  type BrowserTransformProfileInput,
  type BrowserTransformProfileProposalResult,
  type BrowserTransformProfileValidationResult,
  type BrowserTransformValidationDraft,
} from '@/types/models';

const MAX_TRACE_EVENTS = 80;
const MAX_BODY_SHAPE_NODES = 2_048;
const VALIDATION_DRAFT_STORAGE_KEY = 'session.browser-transform-validation-drafts.v1';
const VALIDATION_DRAFT_TTL_MS = 30 * 60_000;
const MAX_VALIDATION_DRAFTS = 16;
export const BROWSER_TRANSFORM_VALIDATION_DRAFT_MAX_BYTES = 256 * 1_024;
const PROFILE_EVIDENCE_STORAGE_KEY = 'session.browser-transform-profile-evidence.v1';
const PROFILE_EVIDENCE_TTL_MS = 30 * 60_000;
const MAX_PROFILE_EVIDENCE = 64;
const CALLABLE_OUTPUT_STORAGE_KEY = 'session.browser-transform-callable-output.v1';
const CALLABLE_OUTPUT_TTL_MS = 30 * 60_000;
const MAX_CALLABLE_OUTPUT_OBSERVATIONS = 64;
const VOLATILE_EXACT_HEADERS = new Set([
  'content-length',
  'date',
  'cookie',
  'authorization',
  'proxy-authorization',
]);
const memoryValidationDrafts = new Map<string, BrowserTransformValidationDraft>();
let validationDraftStorageQueue: Promise<void> = Promise.resolve();
const memoryProfileEvidence = new Map<string, BrowserProfileEvidenceReference>();
let profileEvidenceStorageQueue: Promise<void> = Promise.resolve();
const memoryCallableOutputs = new Map<string, BrowserCallableOutputObservation>();
let callableOutputStorageQueue: Promise<void> = Promise.resolve();

interface BrowserProfileEvidenceReference {
  candidate: BrowserProfileInferenceCandidate;
  requestEvent?: BrowserRecordingEvent;
  createdAt: number;
  expiresAt: number;
}

interface BrowserCallableOutputObservation {
  callableId: string;
  target: BrowserTarget;
  objectKeys: string[];
  createdAt: number;
  expiresAt: number;
}

interface BodyShape {
  format: 'empty' | 'json' | 'form' | 'raw';
  signature: string[];
  byteLength: number;
}

function validationDraftKey(target: BrowserTarget): string {
  return `${target.tabId}:${target.frameId}:${target.documentId || ''}`;
}

function isProfileEvidenceReference(value: unknown): value is BrowserProfileEvidenceReference {
  if (!value || typeof value !== 'object') return false;
  const reference = value as Partial<BrowserProfileEvidenceReference>;
  return typeof reference.createdAt === 'number'
    && typeof reference.expiresAt === 'number'
    && Boolean(reference.candidate && typeof reference.candidate.id === 'string');
}

async function readStoredProfileEvidence(): Promise<Record<string, BrowserProfileEvidenceReference>> {
  try {
    const stored = await browser.storage.session.get(PROFILE_EVIDENCE_STORAGE_KEY);
    const value = stored[PROFILE_EVIDENCE_STORAGE_KEY];
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(
        (entry): entry is [string, BrowserProfileEvidenceReference] => isProfileEvidenceReference(entry[1]),
      ),
    );
  } catch {
    return Object.fromEntries(memoryProfileEvidence);
  }
}

async function writeStoredProfileEvidence(
  references: Record<string, BrowserProfileEvidenceReference>,
): Promise<void> {
  memoryProfileEvidence.clear();
  for (const [key, reference] of Object.entries(references)) memoryProfileEvidence.set(key, reference);
  try {
    await browser.storage.session.set({ [PROFILE_EVIDENCE_STORAGE_KEY]: references });
  } catch {
    // MV2 and test adapters can omit storage.session. The bounded in-memory registry still spans workflow stages.
  }
}

function pruneProfileEvidence(
  references: Record<string, BrowserProfileEvidenceReference>,
  now = Date.now(),
): Record<string, BrowserProfileEvidenceReference> {
  return Object.fromEntries(
    Object.entries(references)
      .filter(([, reference]) => reference.expiresAt > now)
      .sort((left, right) => right[1].createdAt - left[1].createdAt)
      .slice(0, MAX_PROFILE_EVIDENCE),
  );
}

export async function stageBrowserProfileEvidence(snapshot: BrowserRecordingSnapshot): Promise<void> {
  if (!snapshot.profileCandidates.length) return;
  const scoped = recordingSnapshotForScope(snapshot, false);
  const events = new Map(scoped.events.map((event) => [event.id, event]));
  const createdAt = Date.now();
  profileEvidenceStorageQueue = profileEvidenceStorageQueue.then(async () => {
    const stored = pruneProfileEvidence(await readStoredProfileEvidence(), createdAt);
    for (const candidate of scoped.profileCandidates) {
      stored[candidate.id] = {
        candidate,
        requestEvent: events.get(candidate.request.eventId),
        createdAt,
        expiresAt: createdAt + PROFILE_EVIDENCE_TTL_MS,
      };
    }
    await writeStoredProfileEvidence(pruneProfileEvidence(stored, createdAt));
  });
  await profileEvidenceStorageQueue;
}

function sameEvidenceTarget(candidate: BrowserProfileInferenceCandidate, target: BrowserTarget): boolean {
  return candidate.target.tabId === target.tabId
    && candidate.target.frameId === target.frameId
    && (!candidate.target.documentId || !target.documentId || candidate.target.documentId === target.documentId);
}

async function resolveProfileEvidence(
  snapshot: BrowserRecordingSnapshot,
  target: BrowserTarget,
  candidateId: string,
): Promise<Pick<BrowserProfileEvidenceReference, 'candidate' | 'requestEvent'>> {
  const current = snapshot.profileCandidates.find((item) => item.id === candidateId);
  if (current) {
    if (!sameEvidenceTarget(current, target)) {
      throw new ExtensionError('target_denied', '自动推断候选不属于当前共享页面');
    }
    await stageBrowserProfileEvidence(snapshot);
    return {
      candidate: current,
      requestEvent: snapshot.events.find((event) => event.id === current.request.eventId),
    };
  }
  const stored = pruneProfileEvidence(await readStoredProfileEvidence());
  const reference = stored[candidateId];
  if (!reference || !sameEvidenceTarget(reference.candidate, target)) {
    throw new ExtensionError('profile_candidate_not_found', `当前或最近录制中不存在自动推断候选: ${candidateId}`);
  }
  return reference;
}

export async function resolveBrowserProfileCaptureTransaction(
  target: BrowserTarget,
  candidateId: string,
): Promise<BrowserPageCallableTransaction> {
  return (await resolveBrowserProfileCaptureContext(target, candidateId)).transaction;
}

function callableAnalysis(candidate: BrowserProfileInferenceCandidate): BrowserTransformCallableAnalysis {
  return {
    version: 1,
    traceId: candidate.traceId,
    confidence: { ...candidate.confidence },
    flow: candidate.flow.slice(0, 32),
    operations: candidate.sources.slice(0, 16).map((source) => ({
      operation: source.operation,
      destination: source.destination,
      crypto: source.crypto ? structuredClone(source.crypto) : undefined,
    })),
    evidence: candidate.evidence.filter((item) => item.strength !== 'hypothesis').slice(0, 24).map((item) => ({
      kind: item.kind,
      strength: item.strength === 'proven' ? 'proven' : 'supported',
      label: item.label,
    })),
  };
}

async function resolveStagedProfileCandidate(
  target: BrowserTarget,
  candidateId: string,
): Promise<BrowserProfileInferenceCandidate> {
  const reference = pruneProfileEvidence(await readStoredProfileEvidence())[candidateId];
  if (!reference || !sameEvidenceTarget(reference.candidate, target)) {
    throw new ExtensionError('profile_candidate_not_found', `当前捕获会话不存在已暂存的自动推断候选: ${candidateId}`);
  }
  return reference.candidate;
}

export async function resolveBrowserProfileCallableAnalysis(
  target: BrowserTarget,
  candidateId: string,
): Promise<BrowserTransformCallableAnalysis> {
  return callableAnalysis(await resolveStagedProfileCandidate(target, candidateId));
}

export async function resolveBrowserProfileCaptureContext(
  target: BrowserTarget,
  candidateId: string,
): Promise<{ transaction: BrowserPageCallableTransaction; analysis: BrowserTransformCallableAnalysis }> {
  const candidate = await resolveStagedProfileCandidate(target, candidateId);
  if (candidate.direction !== 'request' || candidate.status !== 'capture-required') {
    throw new ExtensionError('profile_evidence_mismatch', '该自动推断候选不需要请求事务捕获');
  }
  const transaction = candidate.capturePlan?.transaction;
  if (!transaction) {
    throw new ExtensionError(
      'transaction_evidence_incomplete',
      '录制证据不足以生成安全的完整请求事务；请检查候选中的在线依赖说明',
    );
  }
  return {
    transaction: structuredClone(transaction),
    analysis: callableAnalysis(candidate),
  };
}

function isCallableOutputObservation(value: unknown): value is BrowserCallableOutputObservation {
  if (!value || typeof value !== 'object') return false;
  const observation = value as Partial<BrowserCallableOutputObservation>;
  return typeof observation.callableId === 'string'
    && typeof observation.createdAt === 'number'
    && typeof observation.expiresAt === 'number'
    && Array.isArray(observation.objectKeys)
    && observation.objectKeys.every((key) => typeof key === 'string')
    && Number.isSafeInteger(observation.target?.tabId)
    && Number.isSafeInteger(observation.target?.frameId);
}

async function readStoredCallableOutputs(): Promise<Record<string, BrowserCallableOutputObservation>> {
  try {
    const stored = await browser.storage.session.get(CALLABLE_OUTPUT_STORAGE_KEY);
    const value = stored[CALLABLE_OUTPUT_STORAGE_KEY];
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(
        (entry): entry is [string, BrowserCallableOutputObservation] => isCallableOutputObservation(entry[1]),
      ),
    );
  } catch {
    return Object.fromEntries(memoryCallableOutputs);
  }
}

async function writeStoredCallableOutputs(
  observations: Record<string, BrowserCallableOutputObservation>,
): Promise<void> {
  memoryCallableOutputs.clear();
  for (const [key, observation] of Object.entries(observations)) memoryCallableOutputs.set(key, observation);
  try {
    await browser.storage.session.set({ [CALLABLE_OUTPUT_STORAGE_KEY]: observations });
  } catch {
    // The in-memory registry is sufficient on adapters without storage.session.
  }
}

function pruneCallableOutputs(
  observations: Record<string, BrowserCallableOutputObservation>,
  now = Date.now(),
): Record<string, BrowserCallableOutputObservation> {
  return Object.fromEntries(
    Object.entries(observations)
      .filter(([, observation]) => observation.expiresAt > now)
      .sort((left, right) => right[1].createdAt - left[1].createdAt)
      .slice(0, MAX_CALLABLE_OUTPUT_OBSERVATIONS),
  );
}

async function stageCallableOutput(
  callable: BrowserPageCallable,
  value: unknown,
): Promise<void> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const objectKeys = Object.keys(value as Record<string, unknown>).sort();
  if (!objectKeys.length || objectKeys.length > 64) return;
  const createdAt = Date.now();
  const observation: BrowserCallableOutputObservation = {
    callableId: callable.id,
    target: { ...callable.target },
    objectKeys,
    createdAt,
    expiresAt: createdAt + CALLABLE_OUTPUT_TTL_MS,
  };
  callableOutputStorageQueue = callableOutputStorageQueue.then(async () => {
    const stored = pruneCallableOutputs(await readStoredCallableOutputs(), createdAt);
    stored[callable.id] = observation;
    await writeStoredCallableOutputs(pruneCallableOutputs(stored, createdAt));
  });
  await callableOutputStorageQueue;
}

async function callableOutputObservation(
  callable: BrowserPageCallable,
): Promise<BrowserCallableOutputObservation | undefined> {
  const observation = pruneCallableOutputs(await readStoredCallableOutputs())[callable.id];
  if (!observation || observation.target.tabId !== callable.target.tabId
    || observation.target.frameId !== callable.target.frameId
    || (observation.target.documentId && callable.target.documentId
      && observation.target.documentId !== callable.target.documentId)) return undefined;
  return observation;
}

function requestEnvelope(
  requestEvent: BrowserRecordingEvent | undefined,
): { format: 'json' | 'form'; keys: string[] } | undefined {
  if (!requestEvent) return undefined;
  for (const format of ['json', 'form'] as const) {
    const prefix = `$body:${format}.`;
    const keys = [...new Set(requestEvent.inputs.flatMap((input) => {
      if (!input.path.startsWith(prefix)) return [];
      const path = input.path.slice(prefix.length);
      return path && !path.includes('.') ? [path] : [];
    }))].sort();
    if (keys.length) return { format, keys };
  }
  return undefined;
}

export function promoteObservedEnvelopeCallable(
  callable: BrowserPageCallable,
  requestEvent: BrowserRecordingEvent | undefined,
  objectKeys: string[],
): BrowserPageCallable {
  if (callable.output.shape !== 'value') return callable;
  const envelope = requestEnvelope(requestEvent);
  const observed = [...new Set(objectKeys)].sort();
  if (!envelope || observed.length !== envelope.keys.length
    || observed.some((key, index) => key !== envelope.keys[index])) return callable;
  return {
    ...callable,
    output: {
      dataType: 'object',
      encoding: envelope.format === 'json' ? 'json' : 'utf8',
      shape: 'envelope',
      paths: envelope.keys.map((key) => `body.${key}`),
    },
  };
}

function isValidationDraft(value: unknown): value is BrowserTransformValidationDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<BrowserTransformValidationDraft>;
  return draft.contractVersion === BROWSER_TRANSFORM_AGENT_CONTRACT_VERSION
    && typeof draft.id === 'string'
    && typeof draft.createdAt === 'number'
    && typeof draft.expiresAt === 'number'
    && Boolean(draft.profile && typeof draft.profile === 'object');
}

async function readStoredValidationDrafts(): Promise<Record<string, BrowserTransformValidationDraft>> {
  try {
    const stored = await browser.storage.session.get(VALIDATION_DRAFT_STORAGE_KEY);
    const value = stored[VALIDATION_DRAFT_STORAGE_KEY];
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, BrowserTransformValidationDraft] =>
        isValidationDraft(entry[1]),
      ),
    );
  } catch {
    return Object.fromEntries(memoryValidationDrafts);
  }
}

async function writeStoredValidationDrafts(
  drafts: Record<string, BrowserTransformValidationDraft>,
): Promise<void> {
  memoryValidationDrafts.clear();
  for (const [key, draft] of Object.entries(drafts)) memoryValidationDrafts.set(key, draft);
  try {
    await browser.storage.session.set({ [VALIDATION_DRAFT_STORAGE_KEY]: drafts });
  } catch {
    // MV2 and a few test adapters do not provide storage.session. The bounded in-memory copy remains usable.
  }
}

function pruneValidationDrafts(
  drafts: Record<string, BrowserTransformValidationDraft>,
  now = Date.now(),
): Record<string, BrowserTransformValidationDraft> {
  return Object.fromEntries(
    Object.entries(drafts)
      .filter(([, draft]) => draft.expiresAt > now)
      .sort((left, right) => right[1].createdAt - left[1].createdAt)
      .slice(0, MAX_VALIDATION_DRAFTS),
  );
}

export function assertBrowserTransformValidationDraftBudget(
  draft: BrowserTransformValidationDraft,
): void {
  const byteLength = new TextEncoder().encode(JSON.stringify(draft)).byteLength;
  if (byteLength > BROWSER_TRANSFORM_VALIDATION_DRAFT_MAX_BYTES) {
    throw new ExtensionError(
      'validation_draft_too_large',
      `验证草稿超过 ${BROWSER_TRANSFORM_VALIDATION_DRAFT_MAX_BYTES} 字节上限`,
    );
  }
}

async function stageBrowserTransformValidation(
  profile: BrowserTransformProfileInput,
  proofLevel: BrowserTransformValidationDraft['proofLevel'],
  comparison?: BrowserPacketComparison,
): Promise<BrowserTransformValidationDraft> {
  const createdAt = Date.now();
  const { id: _profileId, ...unsavedProfile } = profile;
  const draft: BrowserTransformValidationDraft = {
    contractVersion: BROWSER_TRANSFORM_AGENT_CONTRACT_VERSION,
    id: createOpaqueId('browser-transform-validation'),
    profile: unsavedProfile,
    proofLevel,
    comparison: comparison ? {
      mode: comparison.mode,
      equivalent: comparison.equivalent,
      summary: comparison.summary,
    } : undefined,
    createdAt,
    expiresAt: createdAt + VALIDATION_DRAFT_TTL_MS,
  };
  assertBrowserTransformValidationDraftBudget(draft);
  const key = validationDraftKey(profile.target);
  validationDraftStorageQueue = validationDraftStorageQueue.then(async () => {
    const drafts = pruneValidationDrafts(await readStoredValidationDrafts(), createdAt);
    drafts[key] = draft;
    await writeStoredValidationDrafts(pruneValidationDrafts(drafts, createdAt));
  });
  await validationDraftStorageQueue;
  return draft;
}

export async function latestBrowserTransformValidation(
  target: BrowserTarget,
): Promise<BrowserTransformValidationDraft | null> {
  const key = validationDraftKey(target);
  const now = Date.now();
  const stored = await readStoredValidationDrafts();
  const drafts = pruneValidationDrafts(stored, now);
  const draft = drafts[key];
  if (Object.keys(drafts).length !== Object.keys(stored).length) {
    validationDraftStorageQueue = validationDraftStorageQueue.then(() => writeStoredValidationDrafts(drafts));
    await validationDraftStorageQueue;
  }
  return draft || memoryValidationDrafts.get(key) || null;
}

function formValueType(value: string): string {
  if (!value) return 'empty';
  const trimmed = value.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return Array.isArray(parsed)
        ? 'json-array-string'
        : parsed && typeof parsed === 'object'
          ? 'json-object-string'
          : 'string';
    } catch {
      // A ciphertext can legitimately start with a brace; only valid JSON is treated as a nested envelope.
    }
  }
  return 'string';
}

function decodeBody(bodyBase64: string): Uint8Array {
  if (!bodyBase64) return new Uint8Array();
  let binary: string;
  try {
    binary = atob(bodyBase64);
  } catch {
    throw new ExtensionError('packet_invalid_body', '待比较数据包的 Body 不是有效 Base64');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bodyText(packet: BrowserTransformPacket): string {
  return new TextDecoder().decode(decodeBody(packet.bodyBase64));
}

function normalizedHeaders(headers: BrowserTransformHeader[]): Map<string, string[]> {
  const output = new Map<string, string[]>();
  for (const header of headers) {
    const name = header.name.trim().toLowerCase();
    if (!name) continue;
    output.set(name, [...(output.get(name) || []), header.value]);
  }
  return output;
}

function contentType(packet: BrowserTransformPacket): string {
  return normalizedHeaders(packet.headers).get('content-type')?.[0]?.split(';')[0].trim().toLowerCase() || '';
}

function addJsonShape(
  value: unknown,
  path: string,
  output: string[],
  state: { nodes: number; seen: WeakSet<object> },
  depth = 0,
): void {
  state.nodes += 1;
  if (state.nodes > MAX_BODY_SHAPE_NODES || depth > 32) {
    output.push(`${path}:truncated`);
    return;
  }
  if (value === null) {
    output.push(`${path}:null`);
    return;
  }
  if (Array.isArray(value)) {
    output.push(`${path}:array(${value.length})`);
    value.slice(0, 64).forEach((item, index) => addJsonShape(item, `${path}[${index}]`, output, state, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    if (state.seen.has(value as object)) {
      output.push(`${path}:cycle`);
      return;
    }
    state.seen.add(value as object);
    output.push(`${path}:object`);
    for (const key of Object.keys(value as Record<string, unknown>).sort().slice(0, 128)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
      addJsonShape((value as Record<string, unknown>)[key], path === '$' ? `$.${key}` : `${path}.${key}`, output, state, depth + 1);
    }
    return;
  }
  output.push(`${path}:${typeof value}`);
}

function packetBodyShape(packet: BrowserTransformPacket): BodyShape {
  const bytes = decodeBody(packet.bodyBase64);
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) return { format: 'empty', signature: [], byteLength: bytes.byteLength };
  try {
    const value = JSON.parse(text) as unknown;
    const signature: string[] = [];
    addJsonShape(value, '$', signature, { nodes: 0, seen: new WeakSet<object>() });
    return { format: 'json', signature, byteLength: bytes.byteLength };
  } catch {
    // The request is not JSON.
  }
  if (contentType(packet) === 'application/x-www-form-urlencoded') {
    const fields = new Map<string, { count: number; types: Set<string> }>();
    for (const [key, value] of new URLSearchParams(text)) {
      const item = fields.get(key) || { count: 0, types: new Set<string>() };
      item.count += 1;
      item.types.add(formValueType(value));
      fields.set(key, item);
    }
    return {
      format: 'form',
      signature: [...fields.entries()].sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}:${value.count}:${[...value.types].sort().join('|')}`),
      byteLength: bytes.byteLength,
    };
  }
  return {
    format: 'raw',
    signature: [text ? 'body:string' : 'body:empty'],
    byteLength: bytes.byteLength,
  };
}

function routeParts(value: string): { route: string; query: string[] } {
  try {
    const url = new URL(value);
    const fields = new Map<string, number>();
    for (const key of url.searchParams.keys()) fields.set(key, (fields.get(key) || 0) + 1);
    return {
      route: `${url.origin}${url.pathname}`,
      query: [...fields.entries()].sort(([left], [right]) => left.localeCompare(right))
        .map(([key, count]) => `${key}:${count}`),
    };
  } catch {
    return { route: value, query: [] };
  }
}

function comparableExactHeaders(headers: BrowserTransformHeader[]): string[] {
  return headers
    .filter((header) => !VOLATILE_EXACT_HEADERS.has(header.name.toLowerCase()))
    .map((header) => `${header.name.toLowerCase()}:${header.value}`)
    .sort();
}

function equalArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function check(
  checks: BrowserPacketComparisonCheck[],
  id: BrowserPacketComparisonCheck['id'],
  label: string,
  pass: boolean,
  actual?: unknown,
  expected?: unknown,
  warning = false,
): void {
  checks.push({ id, label, status: pass ? 'pass' : warning ? 'warning' : 'fail', actual, expected });
}

export function compareBrowserPackets(
  actual: BrowserTransformPacket,
  expected: BrowserTransformPacket,
  mode: 'structure' | 'exact' = 'structure',
): BrowserPacketComparison {
  const checks: BrowserPacketComparisonCheck[] = [];
  const actualRoute = routeParts(actual.url);
  const expectedRoute = routeParts(expected.url);
  check(checks, 'method', 'HTTP 方法一致', (actual.method || '').toUpperCase() === (expected.method || '').toUpperCase(), actual.method, expected.method);
  check(checks, 'route', '请求来源与路径一致', actualRoute.route === expectedRoute.route, actualRoute.route, expectedRoute.route);
  check(checks, 'query', 'Query 字段结构一致', equalArray(actualRoute.query, expectedRoute.query), actualRoute.query, expectedRoute.query);
  check(checks, 'content-type', 'Content-Type 一致', contentType(actual) === contentType(expected), contentType(actual), contentType(expected));

  const actualShape = packetBodyShape(actual);
  const expectedShape = packetBodyShape(expected);
  check(checks, 'body-format', 'Body 序列化格式一致', actualShape.format === expectedShape.format, actualShape.format, expectedShape.format);
  check(checks, 'body-shape', 'Body 字段与类型结构一致', equalArray(actualShape.signature, expectedShape.signature), actualShape.signature, expectedShape.signature);

  if (mode === 'exact') {
    check(checks, 'body-value', 'Body 字节完全一致', actual.bodyBase64 === expected.bodyBase64, actualShape.byteLength, expectedShape.byteLength);
    const actualHeaders = comparableExactHeaders(actual.headers);
    const expectedHeaders = comparableExactHeaders(expected.headers);
    check(checks, 'headers', '非动态 Header 完全一致', equalArray(actualHeaders, expectedHeaders), actualHeaders, expectedHeaders);
  } else if (actualShape.format === 'raw' && actualShape.byteLength !== expectedShape.byteLength) {
    check(
      checks,
      'body-value',
      '原始 Body 长度不同；结构模式无法证明内容等价',
      false,
      actualShape.byteLength,
      expectedShape.byteLength,
      true,
    );
  }

  const failures = checks.filter((item) => item.status === 'fail');
  const warnings = checks.filter((item) => item.status === 'warning');
  return {
    mode,
    equivalent: failures.length === 0,
    checks,
    summary: failures.length
      ? `${failures.length} 项确定性检查未通过`
      : warnings.length
        ? '结构检查通过，但仍有需要人工确认的原始数据差异'
        : mode === 'exact'
          ? '数据包完全一致'
          : '路由、序列化格式与字段结构一致',
  };
}

function candidateBodyFormat(
  candidate: BrowserProfileInferenceCandidate,
): 'json' | 'form' | 'raw' | undefined {
  if (candidate.request.bodyFormat) return candidate.request.bodyFormat;
  const serializations = [
    candidate.request.serialization,
    ...candidate.request.mappings.map((mapping) => mapping.serialization),
  ];
  if (serializations.includes('json-field')) return 'json';
  if (serializations.includes('form-field')) return 'form';
  if (serializations.includes('raw-body')) return 'raw';
  return undefined;
}

function destinationFields(
  candidate: BrowserProfileInferenceCandidate,
  prefix: 'body.' | 'header.' | 'query.',
): string[] {
  return [...new Set([
    candidate.request.destination,
    ...candidate.request.mappings.map((mapping) => mapping.destination),
  ].filter((destination): destination is string => Boolean(destination?.startsWith(prefix)))
    .map((destination) => destination.slice(prefix.length))
    .filter(Boolean))].sort();
}

export function comparePacketWithInferenceCandidate(
  packet: BrowserTransformPacket,
  candidate: BrowserProfileInferenceCandidate,
): BrowserPacketComparison {
  const checks: BrowserPacketComparisonCheck[] = [];
  const actualRoute = routeParts(packet.url);
  const expectedRoute = routeParts(candidate.request.url);
  check(
    checks,
    'method',
    'HTTP 方法与录制证据一致',
    (packet.method || '').toUpperCase() === candidate.request.method.toUpperCase(),
    packet.method,
    candidate.request.method,
  );
  check(
    checks,
    'route',
    '请求来源与路径和录制证据一致',
    actualRoute.route === expectedRoute.route,
    actualRoute.route,
    expectedRoute.route,
  );
  check(
    checks,
    'query',
    'Query 字段结构覆盖录制证据',
    expectedRoute.query.every((field) => actualRoute.query.includes(field)),
    actualRoute.query,
    expectedRoute.query,
  );

  const expectedFormat = candidateBodyFormat(candidate);
  const actualShape = packetBodyShape(packet);
  check(
    checks,
    'body-format',
    'Body 序列化格式来自录制证据',
    !expectedFormat || actualShape.format === expectedFormat,
    actualShape.format,
    expectedFormat || '未约束',
  );
  const expectedContentType = expectedFormat === 'form'
    ? 'application/x-www-form-urlencoded'
    : expectedFormat === 'json'
      ? 'application/json'
      : undefined;
  check(
    checks,
    'content-type',
    'Content-Type 与录制序列化契约一致',
    !expectedContentType || contentType(packet) === expectedContentType,
    contentType(packet),
    expectedContentType || '未约束',
  );

  const bodyFields = destinationFields(candidate, 'body.');
  let bodyFieldsPresent = true;
  if (expectedFormat === 'json') {
    bodyFieldsPresent = bodyFields.every((field) =>
      actualShape.signature.some((item) => item.startsWith(`$.${field}:`)),
    );
  } else if (expectedFormat === 'form') {
    bodyFieldsPresent = bodyFields.every((field) =>
      actualShape.signature.some((item) => item.startsWith(`${field}:`) && !item.includes('json-object-string')),
    );
  }
  check(
    checks,
    'body-shape',
    '已关联的线上字段存在且没有二次 JSON 包装',
    bodyFieldsPresent,
    actualShape.signature,
    bodyFields,
  );

  const headers = normalizedHeaders(packet.headers);
  const headerFields = destinationFields(candidate, 'header.').map((field) => field.toLowerCase());
  const queryFields = destinationFields(candidate, 'query.');
  if (headerFields.length) {
    check(
      checks,
      'headers',
      '已关联的 Header 字段存在',
      headerFields.every((field) => headers.has(field)),
      [...headers.keys()].sort(),
      headerFields,
    );
  }
  if (queryFields.length) {
    const url = new URL(packet.url);
    check(
      checks,
      'query',
      '已关联的 Query 字段存在',
      queryFields.every((field) => url.searchParams.has(field)),
      [...new Set(url.searchParams.keys())].sort(),
      queryFields,
    );
  }

  const failures = checks.filter((item) => item.status === 'fail');
  return {
    mode: 'structure',
    equivalent: failures.length === 0,
    checks,
    summary: failures.length
      ? `${failures.length} 项录制证据检查未通过`
      : '生成数据包与录制到的路由、序列化格式和字段关联一致',
  };
}

function safeUrl(value?: string, includeValues = false): string | undefined {
  if (!value) return undefined;
  if (includeValues) return value.slice(0, 4_096);
  try {
    const url = new URL(value);
    const keys = [...new Set(url.searchParams.keys())].sort();
    url.search = keys.length ? `?${keys.join('&')}` : '';
    url.hash = '';
    return url.toString();
  } catch {
    return value.split(/[?#]/, 1)[0].slice(0, 4_096);
  }
}

function eventEvidence(event: BrowserRecordingEvent, includeValues: boolean): Record<string, unknown> {
  return {
    id: event.id,
    sequence: event.sequence,
    timestamp: event.timestamp,
    kind: event.kind,
    source: event.source,
    operation: event.operation,
    label: event.label,
    method: event.method,
    statusCode: event.statusCode,
    url: safeUrl(event.url, includeValues),
    crypto: event.crypto,
    transform: event.transform,
    direction: event.direction,
    dataType: event.dataType,
    byteLength: event.byteLength,
    resultByteLength: event.resultByteLength,
    scriptUrl: safeUrl(event.scriptUrl, false),
    stack: event.stack?.slice(0, 12_000),
    callHandleId: event.callHandleId,
    callableCapable: event.callableCapable,
    arguments: event.arguments,
    inputs: event.inputs,
    outputs: event.outputs,
    error: event.error,
    navigation: event.navigation,
    ...(includeValues ? {
      inputPreview: event.inputPreview,
      outputPreview: event.outputPreview,
    } : {}),
  };
}

export function listRecordingTraces(snapshot: BrowserRecordingSnapshot, limit = 40): Array<Record<string, unknown>> {
  const events = new Map(snapshot.events.map((event) => [event.id, event]));
  return snapshot.traces.slice(-Math.max(1, Math.min(limit, 100))).reverse().map((trace) => {
    const traceEvents = trace.eventIds.map((eventId) => events.get(eventId)).filter(Boolean) as BrowserRecordingEvent[];
    const candidates = snapshot.profileCandidates.filter((candidate) => candidate.traceId === trace.id);
    return {
      id: trace.id,
      label: trace.label,
      startedAt: trace.startedAt,
      endedAt: trace.endedAt,
      eventCount: trace.eventIds.length,
      requestCount: trace.requestCount,
      cryptoCount: trace.cryptoCount,
      messageCount: trace.messageCount,
      navigationCount: trace.navigationCount,
      linkedValueCount: trace.linkedValueCount,
      operations: [...new Set(traceEvents.map((event) => event.operation))].slice(0, 24),
      requests: traceEvents.filter((event) => Boolean(event.method && event.url)).slice(-8).map((event) => ({
        eventId: event.id,
        operation: event.operation,
        direction: event.direction,
        method: event.method,
        statusCode: event.statusCode,
        url: safeUrl(event.url),
      })),
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        direction: candidate.direction,
        status: candidate.status,
        confidence: candidate.confidence,
        summary: candidate.summary,
        request: {
          method: candidate.request.method,
          url: safeUrl(candidate.request.url),
          bodyFormat: candidate.request.bodyFormat,
          destinations: candidate.request.mappings.map((mapping) => mapping.destination).filter(Boolean),
        },
      })),
    };
  });
}

export function inspectRecordingEvidence(
  snapshot: BrowserRecordingSnapshot,
  traceId: string,
  eventId?: string,
  includeValues = false,
): Record<string, unknown> {
  const scopedSnapshot = recordingSnapshotForScope(snapshot, includeValues);
  const trace = scopedSnapshot.traces.find((item) => item.id === traceId);
  if (!trace) throw new ExtensionError('recording_trace_not_found', `业务 Trace 不存在: ${traceId}`);
  if (eventId && !trace.eventIds.includes(eventId)) {
    throw new ExtensionError('recording_event_not_found', `事件 ${eventId} 不属于业务 Trace ${traceId}`);
  }
  const selectedIds = eventId ? new Set([eventId]) : new Set(trace.eventIds.slice(-MAX_TRACE_EVENTS));
  const events = scopedSnapshot.events.filter((event) => selectedIds.has(event.id));
  const eventIds = new Set(events.map((event) => event.id));
  return {
    trace,
    truncated: !eventId && trace.eventIds.length > MAX_TRACE_EVENTS,
    events: events.map((event) => eventEvidence(event, includeValues)),
    links: scopedSnapshot.links.filter((link) => eventIds.has(link.fromEventId) || eventIds.has(link.toEventId)),
    candidates: scopedSnapshot.profileCandidates.filter((candidate) => candidate.traceId === traceId),
    callables: scopedSnapshot.callables.filter((callable) => callable.provenance.traceId === traceId)
      .map((callable) => inspectCallable(callable)),
    valuePolicy: includeValues ? 'authorized-preview' : 'metadata-only',
  };
}

export function inspectCallable(callable: BrowserPageCallable): Record<string, unknown> {
  return {
    id: callable.id,
    name: callable.name,
    kind: callable.kind,
    operation: callable.operation,
    algorithm: callable.algorithm,
    crypto: callable.crypto,
    lifecycle: callable.lifecycle,
    execution: callable.execution,
    inputSlots: callable.inputSlots,
    output: callable.output,
    transaction: callable.transaction,
    provenance: callable.provenance,
    createdAt: callable.createdAt,
  };
}

export async function recordingTraceList(
  target: BrowserTarget,
  limit = 40,
): Promise<Array<Record<string, unknown>>> {
  const snapshot = await getBrowserRecording(target, 500, false);
  await stageBrowserProfileEvidence(snapshot);
  return listRecordingTraces(snapshot, limit);
}

export async function recordingEvidenceInspect(
  target: BrowserTarget,
  traceId: string,
  eventId: string | undefined,
  includeValues: boolean,
): Promise<Record<string, unknown>> {
  const snapshot = await getBrowserRecording(target, 500, includeValues);
  await stageBrowserProfileEvidence(snapshot);
  return inspectRecordingEvidence(
    snapshot,
    traceId,
    eventId,
    includeValues,
  );
}

export async function callableInspect(
  target: BrowserTarget,
  callableId?: string,
): Promise<Array<Record<string, unknown>> | Record<string, unknown>> {
  const callables = await listPageCallables(target);
  if (!callableId) return callables.map(inspectCallable);
  const callable = callables.find((item) => item.id === callableId);
  if (!callable) throw new ExtensionError('callable_unavailable', `页面函数已经失效: ${callableId}`);
  return inspectCallable(callable);
}

export async function callableReplay(
  target: BrowserTarget,
  callableId: string,
  args: unknown[],
): Promise<{ callable: Record<string, unknown>; execution: BrowserPageCallableExecution }> {
  const callables = await listPageCallables(target);
  const callable = callables.find((item) => item.id === callableId);
  if (!callable) throw new ExtensionError('callable_unavailable', `页面函数已经失效: ${callableId}`);
  const execution = await executePageCallable(target, callableId, args);
  await stageCallableOutput(callable, execution.value);
  return {
    callable: inspectCallable(callable),
    execution,
  };
}

function originOf(value: string): string {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? '' : origin;
  } catch {
    return '';
  }
}

export async function proposeBrowserTransformProfile(
  target: BrowserTarget,
  candidateId: string,
  callableId: string,
  inputPaths?: string[],
  name?: string,
): Promise<BrowserTransformProfileProposalResult> {
  const [snapshot, callables, tab, frame] = await Promise.all([
    getBrowserRecording(target, 500, false),
    listPageCallables(target),
    browser.tabs.get(target.tabId),
    browser.webNavigation.getFrame({ tabId: target.tabId, frameId: target.frameId }),
  ]);
  const evidence = await resolveProfileEvidence(snapshot, target, candidateId);
  const candidate = evidence.candidate;
  const recordedCallable = callables.find((item) => item.id === callableId);
  if (!recordedCallable) throw new ExtensionError('callable_unavailable', `页面函数已经失效: ${callableId}`);
  const observation = candidate.direction === 'request'
    ? await callableOutputObservation(recordedCallable)
    : undefined;
  const callable = observation
    ? promoteObservedEnvelopeCallable(recordedCallable, evidence.requestEvent, observation.objectKeys)
    : recordedCallable;
  if (!sameEvidenceTarget(candidate, target)) {
    throw new ExtensionError('target_denied', '自动推断候选不属于当前共享页面');
  }
  if (callable.provenance.traceId && callable.provenance.traceId !== candidate.traceId) {
    throw new ExtensionError('profile_evidence_mismatch', '页面函数与自动推断候选不属于同一条业务 Trace');
  }
  const pageUrl = frame?.url || callable.origin;
  if (!pageUrl || originOf(pageUrl) !== callable.origin) {
    throw new ExtensionError('origin_changed', '页面函数所属页面已经发生变化');
  }
  const tabInfo: ActiveTabInfo = {
    id: target.tabId,
    windowId: tab.windowId,
    title: tab.title || '当前页面',
    url: pageUrl,
    incognito: tab.incognito,
    favIconUrl: tab.favIconUrl,
    lastAccessed: tab.lastAccessed,
  };
  const requestEvent = evidence.requestEvent;
  let profile = createBrowserTransformProfileInput(tabInfo, requestEvent, callable, candidate);
  profile = {
    ...profile,
    name: name || profile.name,
    target: { ...target },
    origin: callable.origin,
  };

  if (inputPaths) {
    const directionName = candidate.direction;
    const guide = parseGuidedTransform(profile[directionName], [callable]);
    if (!guide) throw new ExtensionError('profile_compile_failed', '候选明文网关无法转换为受约束的引导配置');
    if (inputPaths.length !== guide.inputPaths.length) {
      throw new ExtensionError(
        'profile_input_mismatch',
        `页面函数需要 ${guide.inputPaths.length} 个动态输入，收到 ${inputPaths.length} 个上下文路径`,
      );
    }
    profile = {
      ...profile,
      [directionName]: compileGuidedTransform({ ...guide, inputPaths }, callable),
    };
  }

  const parsed = v.safeParse(browserTransformProfileInputSchema, profile);
  if (!parsed.success) throw new ExtensionError('profile_compile_failed', '候选明文网关没有通过确定性 Pipeline 编译');
  return {
    profile: parsed.output as BrowserTransformProfileInput,
    proposal: {
      candidateId,
      callableId,
      traceId: candidate.traceId,
      status: candidate.status,
      confidence: candidate.confidence,
      outputContract: callable.output,
      transaction: callable.transaction,
      evidence: candidate.evidence.map((item) => ({
        id: item.id,
        kind: item.kind,
        strength: item.strength,
        label: item.label,
      })),
      compiler: 'browser-transform-guided-v1',
      serializationSource: callable.output.shape === 'envelope'
        ? callable.transaction ? 'captured-request-transaction' : 'validated-callable-envelope'
        : 'recording-evidence',
    },
    next: '调用 profile.validate；验证成功后由用户确认保存，AI 不直接持久化配置',
  };
}

export function applyTransformExecution(
  input: BrowserTransformPacket,
  execution: BrowserTransformExecution,
): BrowserTransformPacket {
  const removed = new Set(execution.removeHeaders.map((name) => name.toLowerCase()));
  const replacements = new Set(execution.setHeaders.map((header) => header.name.toLowerCase()));
  return {
    ...input,
    url: execution.url,
    bodyBase64: execution.bodyBase64,
    headers: [
      ...input.headers.filter((header) => (
        !removed.has(header.name.toLowerCase()) && !replacements.has(header.name.toLowerCase())
      )),
      ...execution.setHeaders,
    ],
  };
}

export async function validateBrowserTransformProposal(
  profile: BrowserTransformProfileInput,
  packet: BrowserTransformPacket,
  observed?: BrowserTransformPacket,
  comparisonMode: 'structure' | 'exact' = 'structure',
  candidateId?: string,
): Promise<BrowserTransformProfileValidationResult> {
  const { profile: normalized, execution } = await validateBrowserTransformProfile(profile, packet);
  const generated = applyTransformExecution(packet, execution);
  const candidate = candidateId
    ? (await resolveProfileEvidence(
      await getBrowserRecording(normalized.target, 500, false),
      normalized.target,
      candidateId,
    )).candidate
    : undefined;
  if (candidate && !sameEvidenceTarget(candidate, normalized.target)) {
    throw new ExtensionError('profile_evidence_mismatch', '验证候选不属于明文网关绑定的页面');
  }
  const comparison = observed
    ? compareBrowserPackets(generated, observed, comparisonMode)
    : candidate
      ? comparePacketWithInferenceCandidate(candidate.direction === 'response' ? packet : generated, candidate)
      : undefined;
  const proofLevel = comparison ? comparison.mode : 'execution-only';
  const valid = !comparison || comparison.equivalent;
  const normalizedProfile: BrowserTransformProfileInput = {
    ...profile,
    id: undefined,
    target: normalized.target,
  };
  const validationDraft = valid
    ? await stageBrowserTransformValidation(
      normalizedProfile,
      proofLevel,
      comparison,
    )
    : undefined;
  return {
    valid,
    saveEligible: valid,
    proofLevel,
    normalizedProfile,
    generated,
    execution,
    comparison,
    validationDraft: validationDraft ? {
      contractVersion: validationDraft.contractVersion,
      id: validationDraft.id,
      createdAt: validationDraft.createdAt,
      expiresAt: validationDraft.expiresAt,
    } : undefined,
    next: comparison
      ? comparison.equivalent
        ? '确定性验证通过；Yakit 已收到待用户确认的明文网关草稿'
        : '数据包对比未通过；检查输入映射或重新选择页面函数'
      : 'Pipeline 已真实回放并生成待确认草稿；如需更强证明，请提供一份浏览器线上请求进行结构对比',
  };
}

export async function validateInferredBrowserTransformProfile(
  target: BrowserTarget,
  candidateId: string,
  callableId: string,
  packet: BrowserTransformPacket,
  inputPaths?: string[],
  name?: string,
  observed?: BrowserTransformPacket,
  comparisonMode: 'structure' | 'exact' = 'structure',
): Promise<BrowserTransformProfileValidationResult> {
  const proposal = await proposeBrowserTransformProfile(
    target,
    candidateId,
    callableId,
    inputPaths,
    name,
  );
  return validateBrowserTransformProposal(
    proposal.profile,
    packet,
    observed,
    comparisonMode,
    candidateId,
  );
}
