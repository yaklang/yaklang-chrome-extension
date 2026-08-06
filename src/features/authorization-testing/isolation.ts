import { browser } from 'wxt/browser';
import type {
  ActiveTabInfo,
  BrowserFirefoxContainerIdentityResult,
  BrowserFirefoxManagedContainer,
  BrowserIncognitoIdentityResult,
  BrowserIsolationContext,
  BrowserIsolationInspection,
  BrowserIsolationProof,
  BrowserTarget,
  PageContext,
  PageContextOptions,
} from '@/types/models';
import { ExtensionError } from '@/shared/errors';
import {
  authenticationFingerprint,
  authenticationStorageEntries,
} from './auth-fingerprint';
import {
  activeTabInfo,
  browserTabDescriptor,
  isolationContextForTab,
  listIsolationCookieStores,
  resolveTabCookieStoreId as resolveCookieStoreId,
  uniqueTabIds,
  type IsolationCookieStore,
  type IsolationTabDescriptor,
} from '@/platform/browser/isolation';
import {
  createFirefoxContainerIdentity,
  firefoxContainerManagementAvailable,
  listFirefoxContainerDescriptors,
  listManagedFirefoxContainerIdentities,
  removeFirefoxContainerIdentity,
} from './firefox-container';
import { AUTHORIZATION_WORKSPACE_TTL_MS } from './lifetime';

export {
  activeTabInfo,
  isolationContextForTab,
  type IsolationCookieStore,
  type IsolationTabDescriptor,
} from '@/platform/browser/isolation';

const PROOF_TTL_MS = AUTHORIZATION_WORKSPACE_TTL_MS;
const MAX_PROOFS = 32;
const MAX_PROOF_STORAGE_BYTES = 64 * 1_024;
const PROOF_STORAGE_KEY = 'browser.authorization.isolation-proofs.v1';
const proofs = new Map<string, BrowserIsolationProof>();
let proofsLoaded = false;

type AuthorizationPageContextCapture = (
  options: PageContextOptions,
  target?: BrowserTarget | number,
) => Promise<PageContext>;

let authorizationPageContextCapture: AuthorizationPageContextCapture | undefined;

export function configureAuthorizationPageContextCapture(
  capture: AuthorizationPageContextCapture,
): void {
  authorizationPageContextCapture = capture;
}

export interface TabLocalAuthenticationEvidence {
  origin: string;
  status: 'authenticated' | 'unauthenticated' | 'unknown';
  authCookieNames: string[];
  authLocalStorageKeys: string[];
  authSessionStorageKeys: string[];
  fingerprint: string;
}

function appendProofReason(
  proof: BrowserIsolationProof,
  reason: string,
): BrowserIsolationProof {
  const reasons = [...proof.reasons];
  if (!reasons.includes(reason)) reasons.push(reason);
  return {
    ...proof,
    reasons: reasons.slice(-16),
  };
}

export function applyTabLocalAuthenticationEvidence(
  proof: BrowserIsolationProof,
  left: TabLocalAuthenticationEvidence,
  right: TabLocalAuthenticationEvidence,
): BrowserIsolationProof {
  if (!proof.sameOrigin
    || proof.cookieStoreRelation !== 'same'
    || left.origin !== right.origin) {
    return proof;
  }
  if (left.status === 'unauthenticated' || right.status === 'unauthenticated') {
    return appendProofReason(proof, '至少一个普通 Tab 明确未登录，不能建立 Tab-local 条件隔离');
  }
  if (left.authCookieNames.length || right.authCookieNames.length) {
    return appendProofReason(proof, '检测到认证 Cookie；普通 Tab 共享 Cookie Store，已拒绝伪造 Tab-local 隔离');
  }
  if (left.authLocalStorageKeys.length || right.authLocalStorageKeys.length) {
    return appendProofReason(proof, '检测到 localStorage 认证材料；普通 Tab 共享站点存储，已拒绝 Tab-local 隔离');
  }
  if (!left.authSessionStorageKeys.length || !right.authSessionStorageKeys.length) {
    return appendProofReason(proof, '没有在两个 Tab 中同时发现独立 sessionStorage 认证材料');
  }
  if (!left.fingerprint || !right.fingerprint || left.fingerprint === right.fingerprint) {
    return appendProofReason(proof, '两个 Tab 的认证快照不能证明不同登录态');
  }
  return {
    ...proof,
    accountEvidenceRelation: 'different',
    requestCredentialRelation: 'unknown',
    refreshCheck: 'passed',
    level: 'conditional',
    reasons: [
      ...proof.reasons.filter((reason) => !reason.includes('不同 tabId 不代表不同登录态')),
      '两个普通 Tab 共享 Cookie Store，但认证材料仅存在于各自 sessionStorage',
      '两个 Tab 的认证快照不同；仍需 A/B 正常请求证明实际发送的认证字段不同',
    ].slice(-16),
  };
}

function authRelated(name: string): boolean {
  return /(auth|token|jwt|session|login|csrf|xsrf|sid|credential|bearer)/i.test(name);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function tabLocalAuthenticationEvidence(
  context: PageContext,
): Promise<TabLocalAuthenticationEvidence> {
  const storage = authenticationStorageEntries(context);
  return {
    origin: new URL(context.document.url).origin,
    status: context.authentication.status,
    authCookieNames: (context.cookies || [])
      .filter((cookie) => authRelated(cookie.name))
      .map((cookie) => cookie.name)
      .slice(0, 100),
    authLocalStorageKeys: storage
      .filter((entry) => entry.area === 'local')
      .map((entry) => entry.key)
      .slice(0, 100),
    authSessionStorageKeys: storage
      .filter((entry) => entry.area === 'session')
      .map((entry) => entry.key)
      .slice(0, 100),
    fingerprint: await authenticationFingerprint(context, sha256),
  };
}

async function inspectTabLocalIsolation(
  proof: BrowserIsolationProof,
): Promise<BrowserIsolationProof> {
  if (proof.level !== 'none'
    || proof.cookieStoreRelation !== 'same'
    || !proof.sameOrigin) {
    return proof;
  }
  if (!authorizationPageContextCapture) {
    return appendProofReason(proof, 'Tab-local 认证预检能力尚未初始化');
  }
  try {
    const [leftContext, rightContext] = await Promise.all([
      authorizationPageContextCapture(
        { includeDom: false, includeStorage: true, includeCookies: true },
        proof.leftTabId,
      ),
      authorizationPageContextCapture(
        { includeDom: false, includeStorage: true, includeCookies: true },
        proof.rightTabId,
      ),
    ]);
    const [left, right] = await Promise.all([
      tabLocalAuthenticationEvidence(leftContext),
      tabLocalAuthenticationEvidence(rightContext),
    ]);
    return applyTabLocalAuthenticationEvidence(proof, left, right);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return appendProofReason(
      proof,
      `Tab-local 认证预检未通过：${message}`.slice(0, 500),
    );
  }
}

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

export function buildIsolationProof(
  left: ActiveTabInfo,
  right: ActiveTabInfo,
  contexts: readonly BrowserIsolationContext[],
  now = Date.now(),
  id: string = crypto.randomUUID(),
): BrowserIsolationProof {
  if (left.id === right.id) throw new ExtensionError('isolation_invalid', '双身份槽位不能选择同一个标签页');
  const leftContext = contexts.find((context) => context.contextId === left.isolationContextId);
  const rightContext = contexts.find((context) => context.contextId === right.isolationContextId);
  const leftStore = leftContext?.cookieStoreId;
  const rightStore = rightContext?.cookieStoreId;
  const cookieStoreRelation = leftStore && rightStore
    ? leftStore === rightStore ? 'same' : 'different'
    : 'unknown';
  const sameOrigin = Boolean(originOf(left.url) && originOf(left.url) === originOf(right.url));
  const reasons: string[] = [];
  let level: BrowserIsolationProof['level'] = 'none';
  if (!leftContext || !rightContext || cookieStoreRelation === 'unknown') {
    reasons.push('至少一个身份无法解析 Cookie Store，不能证明隔离');
  } else if (leftContext.contextId === rightContext.contextId || cookieStoreRelation === 'same') {
    reasons.push('两个标签页共享同一个 Cookie Store；不同 tabId 不代表不同登录态');
  } else {
    level = 'strong';
    reasons.push('两个身份使用不同的浏览器 Cookie Store');
    if (left.incognito !== right.incognito) reasons.push('普通与无痕浏览上下文已分离');
    if (leftContext.kind === 'firefox-container' || rightContext.kind === 'firefox-container') {
      reasons.push('Firefox Container 上下文已分离');
    }
  }
  if (!sameOrigin) reasons.push('两个页面来源不同，后续授权差异计划必须显式确认跨来源语义');
  return {
    version: 1,
    id,
    leftContextId: leftContext?.contextId || left.isolationContextId || `unresolved:${left.id}`,
    rightContextId: rightContext?.contextId || right.isolationContextId || `unresolved:${right.id}`,
    leftTabId: left.id,
    rightTabId: right.id,
    sameOrigin,
    cookieStoreRelation,
    accountEvidenceRelation: 'unknown',
    requestCredentialRelation: 'unknown',
    refreshCheck: level === 'strong' ? 'not-required' : 'failed',
    level,
    reasons,
    createdAt: now,
    expiresAt: now + PROOF_TTL_MS,
  };
}

async function incognitoAccess(): Promise<BrowserIsolationInspection['capabilities']['incognitoAccess']> {
  if (import.meta.env.FIREFOX) return 'unsupported';
  return await browser.extension.isAllowedIncognitoAccess() ? 'allowed' : 'denied';
}

export async function inspectBrowserIsolation(tabIds?: readonly number[]): Promise<BrowserIsolationInspection> {
  const requested = tabIds?.length ? new Set(uniqueTabIds(tabIds)) : undefined;
  const [rawTabs, stores, access, containers] = await Promise.all([
    requested
      ? Promise.all([...requested].map((tabId) => browser.tabs.get(tabId)))
      : browser.tabs.query({}),
    listIsolationCookieStores(),
    incognitoAccess(),
    listFirefoxContainerDescriptors(),
  ]);
  const descriptors = rawTabs.map(browserTabDescriptor).filter((tab): tab is IsolationTabDescriptor => Boolean(tab));
  if (requested && descriptors.length !== requested.size) {
    throw new ExtensionError('target_unavailable', '至少一个身份标签页已经关闭或不是 HTTP(S) 页面');
  }
  const browserKind: BrowserIsolationInspection['browser'] = import.meta.env.FIREFOX ? 'firefox' : 'chromium';
  const contextById = new Map<string, BrowserIsolationContext>();
  const tabs = descriptors.map((tab) => {
    const context = isolationContextForTab(tab, stores, browserKind, containers);
    contextById.set(context.contextId, context);
    return activeTabInfo(tab, context);
  });
  return {
    version: 1,
    inspectedAt: Date.now(),
    browser: browserKind,
    capabilities: {
      incognitoAccess: access,
      containerTabs: browserKind === 'firefox' && firefoxContainerManagementAvailable(),
      managedProfiles: false,
    },
    contexts: [...contextById.values()],
    tabs,
  };
}

export async function resolveTabCookieStoreId(tabId: number): Promise<string> {
  return resolveCookieStoreId(tabId);
}

function purgeProofs(now = Date.now(), reserve = 0): boolean {
  let changed = false;
  for (const [id, proof] of proofs) {
    if (proof.expiresAt <= now) {
      proofs.delete(id);
      changed = true;
    }
  }
  while (proofs.size > MAX_PROOFS - reserve) {
    const oldest = proofs.keys().next().value as string | undefined;
    if (!oldest) break;
    proofs.delete(oldest);
    changed = true;
  }
  return changed;
}

function validStoredProof(value: unknown): value is BrowserIsolationProof {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proof = value as Partial<BrowserIsolationProof>;
  return proof.version === 1
    && typeof proof.id === 'string'
    && proof.id.length > 0
    && proof.id.length <= 160
    && typeof proof.leftContextId === 'string'
    && proof.leftContextId.length > 0
    && proof.leftContextId.length <= 320
    && typeof proof.rightContextId === 'string'
    && proof.rightContextId.length > 0
    && proof.rightContextId.length <= 320
    && Number.isSafeInteger(proof.leftTabId)
    && Number(proof.leftTabId) > 0
    && Number.isSafeInteger(proof.rightTabId)
    && Number(proof.rightTabId) > 0
    && proof.leftTabId !== proof.rightTabId
    && typeof proof.sameOrigin === 'boolean'
    && ['different', 'same', 'unknown'].includes(String(proof.cookieStoreRelation))
    && ['different', 'same', 'unknown'].includes(String(proof.accountEvidenceRelation))
    && ['different', 'same', 'unknown'].includes(String(proof.requestCredentialRelation))
    && ['passed', 'failed', 'not-required'].includes(String(proof.refreshCheck))
    && ['strong', 'conditional', 'none'].includes(String(proof.level))
    && Array.isArray(proof.reasons)
    && proof.reasons.length <= 16
    && proof.reasons.every((reason) => typeof reason === 'string' && reason.length <= 500)
    && typeof proof.createdAt === 'number'
    && typeof proof.expiresAt === 'number'
    && proof.expiresAt > proof.createdAt
    && proof.expiresAt - proof.createdAt <= PROOF_TTL_MS;
}

async function loadProofs(): Promise<void> {
  if (proofsLoaded) return;
  proofsLoaded = true;
  try {
    const stored = await browser.storage.session.get(PROOF_STORAGE_KEY);
    const values = stored[PROOF_STORAGE_KEY];
    if (!Array.isArray(values)) return;
    for (const value of values.slice(-MAX_PROOFS)) {
      if (validStoredProof(value)) proofs.set(value.id, value);
    }
    purgeProofs();
  } catch {
    // Firefox MV2 and tests may not expose storage.session; the bounded in-memory registry remains available.
  }
}

async function saveProofs(): Promise<void> {
  try {
    const retained: BrowserIsolationProof[] = [];
    for (const proof of [...proofs.values()].reverse()) {
      const candidate = [proof, ...retained];
      if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > MAX_PROOF_STORAGE_BYTES) break;
      retained.unshift(proof);
    }
    proofs.clear();
    for (const proof of retained) proofs.set(proof.id, proof);
    await browser.storage.session.set({
      [PROOF_STORAGE_KEY]: retained,
    });
  } catch {
    // The in-memory copy remains the fallback when storage.session is unavailable.
  }
}

export async function createBrowserIsolationProof(leftTabId: number, rightTabId: number): Promise<BrowserIsolationProof> {
  await loadProofs();
  const inspection = await inspectBrowserIsolation([leftTabId, rightTabId]);
  const left = inspection.tabs.find((tab) => tab.id === leftTabId);
  const right = inspection.tabs.find((tab) => tab.id === rightTabId);
  if (!left || !right) throw new ExtensionError('target_unavailable', '双身份标签页已经失效');
  const proof = await inspectTabLocalIsolation(
    buildIsolationProof(left, right, inspection.contexts),
  );
  purgeProofs(proof.createdAt, 1);
  proofs.set(proof.id, proof);
  await saveProofs();
  return proof;
}

export async function getBrowserIsolationProof(id: string): Promise<BrowserIsolationProof> {
  await loadProofs();
  if (purgeProofs()) await saveProofs();
  const proof = proofs.get(id);
  if (!proof) throw new ExtensionError('isolation_stale', '身份隔离证明不存在或已经过期，请重新执行预检');
  const inspection = await inspectBrowserIsolation([proof.leftTabId, proof.rightTabId]);
  const left = inspection.tabs.find((tab) => tab.id === proof.leftTabId);
  const right = inspection.tabs.find((tab) => tab.id === proof.rightTabId);
  if (!left || !right) throw new ExtensionError('isolation_stale', '身份页面已经关闭，请重新执行隔离预检');
  const current = await inspectTabLocalIsolation(
    buildIsolationProof(left, right, inspection.contexts, proof.createdAt, proof.id),
  );
  if (current.leftContextId !== proof.leftContextId
    || current.rightContextId !== proof.rightContextId
    || current.cookieStoreRelation !== proof.cookieStoreRelation
    || current.level !== proof.level) {
    proofs.delete(id);
    await saveProofs();
    throw new ExtensionError('isolation_stale', '身份页面的 Cookie Store 或隔离关系已经变化，请重新执行预检');
  }
  return proof;
}

export async function openIncognitoIdentity(url: string): Promise<BrowserIncognitoIdentityResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ExtensionError('isolation_invalid', '身份页面 URL 无效');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ExtensionError('isolation_invalid', '身份页面只能使用 HTTP(S) URL');
  }
  if (import.meta.env.FIREFOX) {
    throw new ExtensionError('channel_unavailable', 'Firefox 双身份应使用 Container Tab，而不是 Chrome 无痕路径');
  }
  if (!await browser.extension.isAllowedIncognitoAccess()) {
    throw new ExtensionError('incognito_access_denied', '请先在扩展详情中开启“允许在无痕模式下运行”');
  }
  const created = await browser.windows.create({ url: parsed.href, incognito: true, focused: true });
  if (!created) throw new ExtensionError('target_unavailable', '浏览器拒绝创建无痕身份窗口');
  const createdTabs = created.tabs || (created.id ? await browser.tabs.query({ windowId: created.id }) : []);
  const tab = createdTabs.find((candidate) => candidate.id && candidate.incognito);
  if (!tab?.id) throw new ExtensionError('target_unavailable', '无痕窗口已创建，但无法定位身份页面');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const inspection = await inspectBrowserIsolation([tab.id]);
    const activeTab = inspection.tabs[0];
    const context = inspection.contexts.find((candidate) => candidate.contextId === activeTab?.isolationContextId);
    if (activeTab && context?.cookieStoreId) return { tab: activeTab, context };
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  }
  throw new ExtensionError('target_unavailable', '无痕页面尚未获得独立 Cookie Store，请稍后重试');
}

export async function openFirefoxContainerIdentity(input: {
  url: string;
  name?: string;
}): Promise<BrowserFirefoxContainerIdentityResult> {
  const created = await createFirefoxContainerIdentity(input);
  if (!created.tab.id) {
    await removeFirefoxContainerIdentity(created.container.cookieStoreId).catch(() => undefined);
    throw new ExtensionError('target_unavailable', 'Container 已创建，但无法定位身份页面');
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const inspection = await inspectBrowserIsolation([created.tab.id]);
    const tab = inspection.tabs[0];
    const context = inspection.contexts.find(
      (candidate) => candidate.contextId === tab?.isolationContextId,
    );
    if (tab && context?.cookieStoreId === created.container.cookieStoreId) {
      return {
        tab,
        context,
        container: {
          cookieStoreId: created.container.cookieStoreId,
          name: created.container.name,
          color: created.container.color,
          managed: true,
        },
      };
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  }
  await removeFirefoxContainerIdentity(created.container.cookieStoreId).catch(() => undefined);
  throw new ExtensionError(
    'target_unavailable',
    'Container 页面尚未获得独立 Cookie Store，请稍后重试',
  );
}

export async function deleteFirefoxContainerIdentity(
  cookieStoreId: string,
): Promise<{ cookieStoreId: string; removedTabs: number }> {
  return removeFirefoxContainerIdentity(cookieStoreId);
}

export async function listFirefoxContainerIdentities(): Promise<BrowserFirefoxManagedContainer[]> {
  return listManagedFirefoxContainerIdentities();
}
