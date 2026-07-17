import { browser } from 'wxt/browser';
import type {
  ActiveTabInfo, BrowserStorageInventory, BrowserTarget, PageAuthenticationSignals, PageContext, PageContextChange,
  PageContextDiff, PageContextOptions, PageEvalResult, PageNodeAction, PageNodeActionResult,
  PageFormSummary, PageNodeDetails, PageNodeSummary, PageStorageSummary,
} from '@/types/models';
import { executePageOperation } from '@/features/page-context/execution-adapter';
import { getFrameInventory } from '@/features/page-context/frames';
import { getPageLifecycle } from '@/features/page-context/lifecycle';
import { CONTEXT_DIGEST_STORAGE_KEY } from '@/protocol/storage';
import { listCookies } from '@/features/cookies/service';
import { ExtensionError } from '@/shared/errors';
import { getTab, resolveDocumentTarget, scriptingTarget } from '@/platform/browser/targets';

async function collectDocumentContext(input: { options: PageContextOptions; captureId: string }) {
  const MAX_SCANNED_ELEMENTS = 10_000;
  const MAX_NODES = 400;
  const MAX_FORMS = 50;
  const MAX_HEADINGS = 80;
  const MAX_BODY_TEXT = 20 * 1024;
  const MAX_STORAGE_ENTRIES = 100;
  const MAX_STORAGE_VALUE = 4 * 1024;
  const MAX_STORAGE_BYTES = 128 * 1024;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const trim = (value: string | null | undefined, max = 240) => (value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const truncateUtf8 = (value: string, maxBytes: number) => {
    const bytes = encoder.encode(value);
    if (bytes.byteLength <= maxBytes) return { value, byteLength: bytes.byteLength, truncated: false };
    let end = maxBytes;
    while (end > 0) {
      try { return { value: decoder.decode(bytes.subarray(0, end)), byteLength: bytes.byteLength, truncated: true }; }
      catch { end -= 1; }
    }
    return { value: '', byteLength: bytes.byteLength, truncated: true };
  };
  const registryKey = Symbol.for('com.yaklang.browser.context.registry.v1');
  const nodes = new Map<string, Element>();
  const summaries = new Map<string, PageNodeSummary>();
  const nodeIds = new WeakMap<Element, string>();
  const semanticOccurrences = new Map<string, number>();
  const interactive: PageNodeSummary[] = [];
  const forms: PageFormSummary[] = [];
  const headings: Array<{ level: number; text: string }> = [];
  const meta: Record<string, string> = {};
  const limitsReached = new Set<string>();
  let scannedElementCount = 0;
  let passwordFieldCount = 0;
  let hasLoginControl = false;
  let hasLogoutControl = false;
  let hasAccountControl = false;
  let metaCount = 0;

  const selectorHint = (element: Element) => {
    if (element.id) return `#${CSS.escape(element.id)}`.slice(0, 240);
    const testId = element.getAttribute('data-testid');
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`.slice(0, 240);
    const name = element.getAttribute('name');
    if (name) return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`.slice(0, 240);
    const role = element.getAttribute('role');
    return `${element.tagName.toLowerCase()}${role ? `[role="${CSS.escape(role)}"]` : ''}`.slice(0, 240);
  };
  const accessibleName = (element: Element) => {
    const labelledBy = element.getAttribute('aria-labelledby');
    const labelledText = labelledBy?.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
    const labels = 'labels' in element
      ? Array.from((element as HTMLInputElement).labels || []).map((label) => label.textContent || '').join(' ')
      : '';
    return trim(element.getAttribute('aria-label') || labelledText || labels || element.getAttribute('alt')
      || element.getAttribute('title') || element.getAttribute('placeholder') || element.textContent);
  };
  const semanticBase = (element: Element, name: string) => {
    const tag = element.tagName.toLowerCase();
    if (element.id) return `${tag}#${trim(element.id, 120)}`;
    const testId = element.getAttribute('data-testid');
    if (testId) return `${tag}[testid=${trim(testId, 120)}]`;
    const fieldName = element.getAttribute('name');
    if (fieldName) return `${tag}[name=${trim(fieldName, 120)}]`;
    let href = '';
    const rawHref = element.getAttribute('href');
    if (rawHref) {
      try {
        const parsed = new URL(rawHref, location.href);
        href = `${parsed.origin}${parsed.pathname}`;
      } catch {
        href = rawHref.split('?')[0];
      }
    }
    return `${tag}|${element.getAttribute('role') || ''}|${element.getAttribute('type') || ''}|${trim(href, 180)}|${name}`;
  };
  const register = (element: Element, shadowDepth: number) => {
    const existing = nodeIds.get(element);
    if (existing) return summaries.get(existing);
    if (nodes.size >= MAX_NODES) {
      limitsReached.add('interactive_nodes');
      return undefined;
    }
    const name = accessibleName(element);
    const base = semanticBase(element, name);
    const occurrence = semanticOccurrences.get(base) || 0;
    semanticOccurrences.set(base, occurrence + 1);
    const nodeId = `n${(nodes.size + 1).toString(36)}`;
    const style = getComputedStyle(element);
    const visible = element.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    const rawHref = element.getAttribute('href');
    let href: string | undefined;
    if (rawHref) {
      try { href = new URL(rawHref, location.href).href.slice(0, 2_048); } catch { href = rawHref.slice(0, 2_048); }
    }
    const control = element as HTMLInputElement;
    const summary: PageNodeSummary = {
      nodeId,
      semanticKey: `${base}|${occurrence}`.slice(0, 500),
      tag: element.tagName.toLowerCase(),
      role: trim(element.getAttribute('role'), 120),
      type: trim(element.getAttribute('type'), 120),
      name: trim(element.getAttribute('name'), 240),
      text: trim(element.textContent),
      accessibleName: name,
      selectorHint: selectorHint(element),
      visible,
      disabled: Boolean(control.disabled || element.getAttribute('aria-disabled') === 'true'),
      required: Boolean(control.required || element.getAttribute('aria-required') === 'true'),
      ...(element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type) ? { checked: element.checked } : {}),
      ...(href ? { href } : {}),
      ...(element.getAttribute('placeholder') ? { placeholder: trim(element.getAttribute('placeholder')) } : {}),
      ...(element.getAttribute('autocomplete') ? { autocomplete: trim(element.getAttribute('autocomplete')) } : {}),
      shadowDepth,
    };
    nodes.set(nodeId, element);
    nodeIds.set(element, nodeId);
    summaries.set(nodeId, summary);
    return summary;
  };

  const interactiveSelector = 'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[contenteditable="true"]';
  const visitRoot = (root: Document | ShadowRoot, shadowDepth: number) => {
    if (root instanceof ShadowRoot && root.host.tagName.toLowerCase() === 'yakit-browser-agent') return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let current = walker.nextNode();
    while (current) {
      const element = current as Element;
      if (scannedElementCount >= MAX_SCANNED_ELEMENTS) {
        limitsReached.add('scanned_elements');
        return;
      }
      scannedElementCount += 1;
      if (input.options.includeDom !== false && element.matches(interactiveSelector)) {
        const summary = register(element, shadowDepth);
        if (summary) {
          interactive.push(summary);
          const label = String(summary.accessibleName || summary.text || '');
          if (element instanceof HTMLInputElement && element.type === 'password') passwordFieldCount += 1;
          if (/\b(log\s?in|sign\s?in)\b|登录|登入/i.test(label)) hasLoginControl = true;
          if (/\b(log\s?out|sign\s?out)\b|退出|注销/i.test(label)) hasLogoutControl = true;
          if (/\b(account|profile|dashboard)\b|账户|账号|个人中心/i.test(label)) hasAccountControl = true;
        }
      }
      if (input.options.includeDom !== false && /^H[1-6]$/.test(element.tagName) && headings.length < MAX_HEADINGS) {
        headings.push({ level: Number(element.tagName.slice(1)), text: trim(element.textContent, 500) });
      }
      if (input.options.includeDom !== false && element instanceof HTMLFormElement && forms.length < MAX_FORMS) {
        const formSummary = register(element, shadowDepth);
        if (formSummary) {
          const fieldNodeIds: string[] = [];
          const fieldWalker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT);
          let field = fieldWalker.nextNode();
          while (field && fieldNodeIds.length < 100) {
            const fieldElement = field as Element;
            if (fieldElement.matches('input,select,textarea,button')) {
              const fieldNodeId = register(fieldElement, shadowDepth)?.nodeId;
              if (fieldNodeId) fieldNodeIds.push(fieldNodeId);
            }
            field = fieldWalker.nextNode();
          }
          forms.push({
            nodeId: formSummary.nodeId,
            semanticKey: formSummary.semanticKey,
            action: element.action.slice(0, 2_048),
            method: element.method || 'get',
            name: element.name.slice(0, 240),
            fieldNodeIds,
          });
        }
      }
      if (element instanceof HTMLMetaElement && metaCount < 80) {
        const key = element.getAttribute('name') || element.getAttribute('property') || '';
        if (key) {
          meta[key.slice(0, 240)] = (element.content || '').slice(0, 2_048);
          metaCount += 1;
        }
      }
      if (element.shadowRoot) visitRoot(element.shadowRoot, shadowDepth + 1);
      current = walker.nextNode();
    }
  };
  if (input.options.includeDom !== false) visitRoot(document, 0);
  if (headings.length >= MAX_HEADINGS) limitsReached.add('headings');
  if (forms.length >= MAX_FORMS) limitsReached.add('forms');

  const storageError = (error: unknown) => {
    try { return (error instanceof Error ? error.message : String(error)).slice(0, 500); }
    catch { return 'Storage access failed'; }
  };
  const readStorage = (name: 'localStorage' | 'sessionStorage'): PageStorageSummary => {
    const entries: Array<{ key: string; value: string; byteLength: number; authRelated: boolean; truncated: boolean }> = [];
    let approximateBytes = 0;
    let storage: Storage | undefined;
    try {
      storage = globalThis[name];
    } catch (error) {
      return { supported: false, entries, totalEntries: 0, approximateBytes, truncated: false, error: storageError(error) };
    }
    if (!storage) return { supported: false, entries, totalEntries: 0, approximateBytes, truncated: false };
    let totalEntries = 0;
    try {
      totalEntries = storage.length;
      for (let index = 0; index < totalEntries && entries.length < MAX_STORAGE_ENTRIES; index += 1) {
        const key = storage.key(index);
        if (!key) continue;
        const raw = storage.getItem(key) || '';
        if (approximateBytes >= MAX_STORAGE_BYTES) break;
        const bounded = truncateUtf8(raw, Math.min(MAX_STORAGE_VALUE, MAX_STORAGE_BYTES - approximateBytes));
        approximateBytes += encoder.encode(bounded.value).byteLength;
        entries.push({ key: key.slice(0, 500), value: bounded.value, byteLength: bounded.byteLength, authRelated: /(auth|token|jwt|session|login|user|csrf|sid)/i.test(key), truncated: bounded.truncated });
      }
      return { supported: true, entries, totalEntries, approximateBytes, truncated: entries.length < totalEntries };
    } catch (error) {
      return { supported: true, entries, totalEntries, approximateBytes, truncated: true, error: storageError(error) };
    }
  };

  const collectStorageInventory = async (): Promise<BrowserStorageInventory> => {
    const normalizeKey = (key: IDBValidKey): string | number => {
      if (typeof key === 'string') return key.slice(0, 500);
      if (typeof key === 'number') return key;
      if (key instanceof Date) return key.toISOString();
      if (Array.isArray(key)) return JSON.stringify(key).slice(0, 500);
      return `[binary key: ${key.byteLength} bytes]`;
    };
    const requestValue = <T,>(request: IDBRequest<T>, timeoutMs = 700): Promise<T> => new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => reject(new Error('IndexedDB request timed out')), timeoutMs);
      request.onsuccess = () => { globalThis.clearTimeout(timer); resolve(request.result); };
      request.onerror = () => { globalThis.clearTimeout(timer); reject(request.error || new Error('IndexedDB request failed')); };
    });
    let indexedDBApi: IDBFactory | undefined;
    let indexedDBAccessError: string | undefined;
    try { indexedDBApi = globalThis.indexedDB; }
    catch (error) { indexedDBAccessError = storageError(error); }
    const openDatabase = (api: IDBFactory, name: string): Promise<IDBDatabase> => new Promise((resolve, reject) => {
      const request = api.open(name);
      let settled = false;
      const timer = globalThis.setTimeout(() => { settled = true; reject(new Error('IndexedDB open timed out')); }, 700);
      request.onsuccess = () => {
        globalThis.clearTimeout(timer);
        if (settled) request.result.close(); else { settled = true; resolve(request.result); }
      };
      request.onerror = () => { globalThis.clearTimeout(timer); if (!settled) { settled = true; reject(request.error || new Error('IndexedDB open failed')); } };
      request.onblocked = () => { globalThis.clearTimeout(timer); if (!settled) { settled = true; reject(new Error('IndexedDB open was blocked')); } };
    });
    const indexedResult: BrowserStorageInventory['indexedDB'] = {
      supported: Boolean(indexedDBApi && typeof indexedDBApi.databases === 'function'),
      databases: [],
      truncated: false,
      ...(indexedDBAccessError ? { error: indexedDBAccessError } : {}),
    };
    if (indexedResult.supported && indexedDBApi) {
      try {
        const allDatabases = await Promise.race([
          indexedDBApi.databases(),
          new Promise<never>((_, reject) => globalThis.setTimeout(() => reject(new Error('IndexedDB inventory timed out')), 1_000)),
        ]);
        const databases = allDatabases.filter((database) => database.name).slice(0, 10);
        indexedResult.truncated = allDatabases.length > databases.length;
        let remainingStores = 50;
        for (const databaseInfo of databases) {
          const name = databaseInfo.name!;
          try {
            const database = await openDatabase(indexedDBApi, name);
            const storeNames = Array.from(database.objectStoreNames).slice(0, Math.min(20, remainingStores));
            const databaseSummary: BrowserStorageInventory['indexedDB']['databases'][number] = {
              name: name.slice(0, 500), version: database.version, stores: [],
              truncated: database.objectStoreNames.length > storeNames.length,
            };
            if (storeNames.length > 0) {
              for (const storeName of storeNames) {
                try {
                  const store = database.transaction(storeName, 'readonly').objectStore(storeName);
                  const [count, keys] = await Promise.all([
                    requestValue(store.count()),
                    requestValue(store.getAllKeys(undefined, 10)),
                  ]);
                  databaseSummary.stores.push({
                    name: storeName.slice(0, 500),
                    keyPath: typeof store.keyPath === 'string'
                      ? store.keyPath.slice(0, 500)
                      : Array.isArray(store.keyPath) ? store.keyPath.map((item) => item.slice(0, 500)).slice(0, 20) : null,
                    autoIncrement: store.autoIncrement,
                    count,
                    sampleKeys: keys.map(normalizeKey),
                    truncated: count > keys.length,
                  });
                } catch (error) {
                  databaseSummary.stores.push({
                    name: storeName.slice(0, 500), keyPath: null, autoIncrement: false, sampleKeys: [], truncated: true,
                    error: storageError(error),
                  });
                }
                remainingStores -= 1;
              }
            }
            database.close();
            indexedResult.databases.push(databaseSummary);
            if (remainingStores <= 0) { indexedResult.truncated = true; break; }
          } catch (error) {
            indexedResult.databases.push({
              name: name.slice(0, 500), version: databaseInfo.version || 0, stores: [], truncated: true,
              error: storageError(error),
            });
          }
        }
      } catch (error) {
        indexedResult.error = storageError(error);
      }
    }
    let cacheStorageApi: CacheStorage | undefined;
    let cacheStorageAccessError: string | undefined;
    try { cacheStorageApi = globalThis.caches; }
    catch (error) { cacheStorageAccessError = storageError(error); }
    const cacheResult: BrowserStorageInventory['cacheStorage'] = {
      supported: Boolean(cacheStorageApi && typeof cacheStorageApi.keys === 'function'),
      names: [],
      truncated: false,
      ...(cacheStorageAccessError ? { error: cacheStorageAccessError } : {}),
    };
    if (cacheResult.supported && cacheStorageApi) {
      try {
        const names = await cacheStorageApi.keys();
        cacheResult.names = names.slice(0, 50).map((name) => name.slice(0, 500));
        cacheResult.truncated = names.length > cacheResult.names.length;
      } catch (error) {
        cacheResult.error = storageError(error);
      }
    }
    return { indexedDB: indexedResult, cacheStorage: cacheResult };
  };

  const cryptoPattern = /(encrypt|decrypt|crypto|cipher|sign|hash|md5|sha|aes|rsa|sm2|sm3|sm4|encode|decode)/i;
  const cryptoCandidates: Array<{ path: string; kind: string }> = [];
  for (const key of Object.getOwnPropertyNames(window).slice(0, 5_000)) {
    if (!cryptoPattern.test(key)) continue;
    try { cryptoCandidates.push({ path: key, kind: typeof Reflect.get(window, key) }); }
    catch { cryptoCandidates.push({ path: key, kind: 'unreadable' }); }
    if (cryptoCandidates.length >= 100) break;
  }
  const collectBodyText = () => {
    if (input.options.includeDom === false || !document.body) return { value: '', truncated: false };
    const parts: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let remaining = MAX_BODY_TEXT;
    let visited = 0;
    let truncated = false;
    let current = walker.nextNode();
    while (current && remaining > 0 && visited < 5_000) {
      visited += 1;
      const parent = current.parentElement;
      if (parent && !parent.closest('script,style,noscript,template,[hidden],[aria-hidden="true"],yakit-browser-agent')) {
        const raw = current.nodeValue || '';
        const normalized = raw.slice(0, MAX_BODY_TEXT).replace(/\s+/g, ' ').trim();
        if (normalized) {
          const separatorBytes = parts.length ? 1 : 0;
          if (remaining <= separatorBytes) { truncated = true; break; }
          const bounded = truncateUtf8(normalized, remaining - separatorBytes);
          parts.push(bounded.value);
          remaining -= encoder.encode(bounded.value).byteLength + separatorBytes;
          truncated ||= bounded.truncated || raw.length > MAX_BODY_TEXT;
        }
      }
      current = walker.nextNode();
    }
    if (current || visited >= 5_000) truncated = true;
    return { value: parts.join('\n'), truncated };
  };
  const bodyText = collectBodyText();
  let storageInventory: BrowserStorageInventory | undefined;
  if (input.options.includeStorage) {
    try {
      storageInventory = await collectStorageInventory();
    } catch (error) {
      const message = storageError(error);
      storageInventory = {
        indexedDB: { supported: false, databases: [], truncated: false, error: message },
        cacheStorage: { supported: false, names: [], truncated: false, error: message },
      };
    }
  }
  const localStorageSummary = input.options.includeStorage ? readStorage('localStorage') : undefined;
  const sessionStorageSummary = input.options.includeStorage ? readStorage('sessionStorage') : undefined;
  const registry = { captureId: input.captureId, nodes, summaries };
  Reflect.set(globalThis, registryKey, registry);
  return {
    document: {
      title: document.title.slice(0, 1_000),
      url: location.href.slice(0, 8_192),
      referrer: document.referrer.slice(0, 8_192),
      language: (document.documentElement.lang || navigator.language).slice(0, 100),
      charset: document.characterSet,
      readyState: document.readyState,
      bodyText: bodyText.value,
      bodyTextTruncated: bodyText.truncated,
      headings,
      forms,
      interactive,
      meta,
      localStorage: localStorageSummary,
      sessionStorage: sessionStorageSummary,
      storageInventory,
      cryptoCandidates,
      scannedElementCount,
      limitsReached: [...limitsReached],
    },
    authenticationSeed: { passwordFieldCount, hasLoginControl, hasLogoutControl, hasAccountControl },
  };
}

interface ContextDigest {
  captureId: string;
  documentId?: string;
  title: string;
  url: string;
  authentication: PageAuthenticationSignals['status'];
  included: string;
  nodes: Map<string, PageContextChange & { signature: string }>;
  formSignature: string;
  storageKeys: Set<string>;
  cookieNames: Set<string>;
}

const contextDigests = new Map<string, ContextDigest>();
const MAX_MEMORY_CONTEXT_DIGESTS = 32;
const MAX_PERSISTED_CONTEXT_DIGESTS = 8;
const contextSessionStorage = (browser.storage as unknown as {
  session?: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
}).session;
let contextPersistTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

interface StoredContextDigest extends Omit<ContextDigest, 'nodes' | 'storageKeys' | 'cookieNames'> {
  nodes: Array<[string, PageContextChange & { signature: string }]>;
  storageKeys: string[];
  cookieNames: string[];
}

function storedDigest(input: ContextDigest): StoredContextDigest {
  return { ...input, nodes: [...input.nodes], storageKeys: [...input.storageKeys], cookieNames: [...input.cookieNames] };
}

async function restoreContextDigests(): Promise<void> {
  if (!contextSessionStorage) return;
  try {
    const stored = await contextSessionStorage.get(CONTEXT_DIGEST_STORAGE_KEY);
    const values = stored[CONTEXT_DIGEST_STORAGE_KEY];
    if (!Array.isArray(values)) return;
    for (const item of values.slice(-MAX_PERSISTED_CONTEXT_DIGESTS)) {
      const entry = item as Partial<StoredContextDigest> & { key?: unknown };
      if (typeof entry.key !== 'string' || typeof entry.captureId !== 'string' || typeof entry.title !== 'string'
        || typeof entry.url !== 'string' || !Array.isArray(entry.nodes) || !Array.isArray(entry.storageKeys)
        || !Array.isArray(entry.cookieNames) || !['authenticated', 'unauthenticated', 'unknown'].includes(String(entry.authentication))) continue;
      contextDigests.set(entry.key, {
        captureId: entry.captureId,
        documentId: typeof entry.documentId === 'string' ? entry.documentId : undefined,
        title: entry.title,
        url: entry.url,
        authentication: entry.authentication as PageAuthenticationSignals['status'],
        included: typeof entry.included === 'string' ? entry.included : 'dom',
        nodes: new Map(entry.nodes),
        formSignature: typeof entry.formSignature === 'string' ? entry.formSignature : '',
        storageKeys: new Set(entry.storageKeys.filter((value): value is string => typeof value === 'string')),
        cookieNames: new Set(entry.cookieNames.filter((value): value is string => typeof value === 'string')),
      });
    }
  } catch {
    // Context diff remains available in memory when session storage is unavailable.
  }
}

const contextDigestRestore = restoreContextDigests();

function scheduleContextDigestPersist(): void {
  if (!contextSessionStorage || contextPersistTimer) return;
  contextPersistTimer = globalThis.setTimeout(() => {
    contextPersistTimer = undefined;
    const values = [...contextDigests].slice(-MAX_PERSISTED_CONTEXT_DIGESTS).map(([key, digest]) => ({ key, ...storedDigest(digest) }));
    void contextSessionStorage.set({ [CONTEXT_DIGEST_STORAGE_KEY]: values }).catch(() => undefined);
  }, 250);
}

browser.tabs.onRemoved.addListener((tabId) => {
  let changed = false;
  for (const key of contextDigests.keys()) {
    if (!key.startsWith(`${tabId}:`)) continue;
    contextDigests.delete(key);
    changed = true;
  }
  if (changed) scheduleContextDigestPersist();
});

function difference(left: Set<string>, right: Set<string>, limit = 100): string[] {
  return [...left].filter((item) => !right.has(item)).slice(0, limit);
}

async function contextDiff(context: Omit<PageContext, 'diff'>): Promise<PageContextDiff> {
  await contextDigestRestore;
  const key = `${context.target.tabId}:${context.target.frameId}`;
  const nodes = new Map(context.document.interactive.map((node) => [node.semanticKey, {
    semanticKey: node.semanticKey, tag: node.tag, text: node.accessibleName || node.text, nodeId: node.nodeId,
    signature: `${node.visible}|${node.disabled}|${node.required}|${node.checked ?? ''}|${node.href || ''}`,
  }]));
  const storageKeys = new Set([
    ...(context.document.localStorage?.entries.map((entry) => `local:${entry.key}`) || []),
    ...(context.document.sessionStorage?.entries.map((entry) => `session:${entry.key}`) || []),
  ]);
  const cookieNames = new Set(context.authentication.cookieNames);
  const current: ContextDigest = {
    captureId: context.captureId,
    documentId: context.target.documentId,
    title: context.document.title,
    url: context.document.url,
    authentication: context.authentication.status,
    included: `${context.included.dom}:${context.included.storage}:${context.included.cookies}`,
    nodes,
    formSignature: context.document.forms.map((form) => `${form.semanticKey}|${form.method}|${form.action}|${form.fieldNodeIds.length}`).join('\n'),
    storageKeys,
    cookieNames,
  };
  const previous = contextDigests.get(key);
  contextDigests.delete(key);
  contextDigests.set(key, current);
  while (contextDigests.size > MAX_MEMORY_CONTEXT_DIGESTS) contextDigests.delete(contextDigests.keys().next().value!);
  scheduleContextDigestPersist();
  if (!previous) {
    return {
      kind: 'initial', toCaptureId: context.captureId, changedSections: [],
      addedNodes: [], removedNodes: [], addedStorageKeys: [], removedStorageKeys: [], addedCookieNames: [], removedCookieNames: [],
    };
  }
  const changedSections = new Set<PageContextDiff['changedSections'][number]>();
  const sameOptions = previous.included === current.included;
  const [previousDom, previousStorage, previousCookies] = previous.included.split(':').map((value) => value === 'true');
  if (!sameOptions) changedSections.add('capture_options');
  if (previous.title !== current.title || previous.url !== current.url || previous.documentId !== current.documentId) changedSections.add('document');
  if (sameOptions && previous.authentication !== current.authentication) changedSections.add('authentication');
  if (previousDom && context.included.dom && previous.formSignature !== current.formSignature) changedSections.add('forms');
  const addedNodes = previousDom && context.included.dom ? [...current.nodes.entries()].filter(([semanticKey, node]) => {
    const old = previous.nodes.get(semanticKey);
    return !old || old.signature !== node.signature;
  }).map(([, node]) => node).slice(0, 50) : [];
  const removedNodes = previousDom && context.included.dom ? [...previous.nodes.entries()].filter(([semanticKey, node]) => {
    const next = current.nodes.get(semanticKey);
    return !next || next.signature !== node.signature;
  }).map(([, node]) => ({ semanticKey: node.semanticKey, tag: node.tag, text: node.text })).slice(0, 50) : [];
  if (addedNodes.length || removedNodes.length) changedSections.add('interactive');
  const addedStorageKeys = previousStorage && context.included.storage ? difference(current.storageKeys, previous.storageKeys) : [];
  const removedStorageKeys = previousStorage && context.included.storage ? difference(previous.storageKeys, current.storageKeys) : [];
  if (addedStorageKeys.length || removedStorageKeys.length) changedSections.add('storage');
  const addedCookieNames = previousCookies && context.included.cookies ? difference(current.cookieNames, previous.cookieNames) : [];
  const removedCookieNames = previousCookies && context.included.cookies ? difference(previous.cookieNames, current.cookieNames) : [];
  if (addedCookieNames.length || removedCookieNames.length) changedSections.add('cookies');
  const documentChanged = Boolean(previous.documentId && current.documentId && previous.documentId !== current.documentId);
  return {
    kind: documentChanged ? 'document_changed' : changedSections.size ? 'changed' : 'unchanged',
    fromCaptureId: previous.captureId,
    toCaptureId: context.captureId,
    changedSections: [...changedSections], addedNodes, removedNodes,
    addedStorageKeys, removedStorageKeys, addedCookieNames, removedCookieNames,
  };
}

function authenticationSignals(
  seed: { passwordFieldCount: number; hasLoginControl: boolean; hasLogoutControl: boolean; hasAccountControl: boolean },
  documentContext: PageContext['document'],
  cookieNames: string[],
): PageAuthenticationSignals {
  const evidence: string[] = [];
  let score = 0;
  if (seed.hasLogoutControl) { score += 3; evidence.push('页面存在退出登录控件'); }
  if (seed.hasAccountControl) { score += 2; evidence.push('页面存在账户或个人中心控件'); }
  if (seed.passwordFieldCount > 0) { score -= 2; evidence.push(`页面存在 ${seed.passwordFieldCount} 个密码输入框`); }
  if (seed.hasLoginControl) { score -= 1; evidence.push('页面存在登录控件'); }
  const authCookieNames = cookieNames.filter((name) => /(auth|token|jwt|session|login|sid)/i.test(name));
  if (authCookieNames.length > 0) { score += 2; evidence.push(`发现 ${authCookieNames.length} 个疑似认证 Cookie 名称`); }
  const storageKeys = [
    ...(documentContext.localStorage?.entries || []),
    ...(documentContext.sessionStorage?.entries || []),
  ].filter((entry) => entry.authRelated).map((entry) => entry.key);
  if (storageKeys.length > 0) { score += 2; evidence.push(`发现 ${storageKeys.length} 个疑似认证 Storage 键`); }
  return {
    status: score >= 2 ? 'authenticated' : score <= -2 ? 'unauthenticated' : 'unknown',
    confidence: Math.min(0.95, Math.round((0.3 + Math.abs(score) * 0.1) * 100) / 100),
    evidence: evidence.slice(0, 8),
    passwordFieldCount: seed.passwordFieldCount,
    cookieNames: cookieNames.slice(0, 200),
    storageKeys: storageKeys.slice(0, 200),
  };
}

export async function capturePageContext(options: PageContextOptions = {}, input?: BrowserTarget | number): Promise<PageContext> {
  const tab = await getTab(typeof input === 'number' ? input : input?.tabId);
  if (!/^https?:/i.test(tab.url)) throw new Error('当前页面不允许采集上下文');
  const target = await resolveDocumentTarget(input || tab.id);
  const captureId = crypto.randomUUID();
  let injections: Array<Browser.scripting.InjectionResult & { error?: string }>;
  try {
    injections = await browser.scripting.executeScript({
      target: scriptingTarget(target),
      world: 'MAIN',
      func: collectDocumentContext,
      args: [{ options, captureId }],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ExtensionError('context_capture_failed', `页面上下文采集失败：${message}`);
  }
  if (injections.length !== 1) throw new ExtensionError('context_capture_failed', '页面上下文采集无法唯一定位目标文档');
  const [{ result, error }] = injections;
  if (error) throw new ExtensionError('context_capture_failed', `页面上下文采集失败：${error}`);
  if (result === undefined) throw new ExtensionError('context_capture_failed', '页面上下文采集脚本没有返回结果');
  const collected = result as Awaited<ReturnType<typeof collectDocumentContext>>;
  const [cookies, frames, lifecycle] = await Promise.all([
    options.includeCookies ? listCookies(collected.document.url) : undefined,
    getFrameInventory(target.tabId),
    getPageLifecycle(target.tabId, target.frameId, target.documentId),
  ]);
  const authentication = authenticationSignals(collected.authenticationSeed, collected.document, cookies?.map((cookie) => cookie.name) || []);
  const contextWithoutDiff: Omit<PageContext, 'diff'> = {
    captureId,
    capturedAt: Date.now(),
    included: { dom: options.includeDom !== false, storage: options.includeStorage === true, cookies: options.includeCookies === true },
    tab,
    target,
    frames,
    lifecycle,
    authentication,
    document: collected.document,
    cookies,
  };
  return { ...contextWithoutDiff, diff: await contextDiff(contextWithoutDiff) };
}

function operateRegisteredNode(input: { captureId: string; nodeId: string; operation: 'inspect' | PageNodeAction; value?: string }) {
  const registryKey = Symbol.for('com.yaklang.browser.context.registry.v1');
  const registry = Reflect.get(globalThis, registryKey) as {
    captureId?: string;
    nodes?: Map<string, Element>;
    summaries?: Map<string, PageNodeSummary>;
  } | undefined;
  if (!registry || registry.captureId !== input.captureId) {
    return { ok: false as const, code: 'stale_node', message: '上下文快照已经失效，请重新采集页面上下文' };
  }
  const element = registry.nodes?.get(input.nodeId);
  const summary = registry.summaries?.get(input.nodeId);
  if (!element || !summary || !element.isConnected) {
    return { ok: false as const, code: 'stale_node', message: '页面元素已被替换或移除，请重新采集页面上下文' };
  }
  const safeAttributes = new Set(['id', 'name', 'type', 'role', 'href', 'action', 'method', 'placeholder', 'autocomplete', 'disabled', 'required', 'checked', 'aria-label', 'aria-labelledby', 'aria-disabled', 'aria-required']);
  const attributes: Record<string, string> = {};
  for (const attribute of Array.from(element.attributes).slice(0, 80)) {
    if (safeAttributes.has(attribute.name)) attributes[attribute.name] = attribute.value.slice(0, 2_048);
  }
  const rect = element.getBoundingClientRect();
  const node = {
    ...summary,
    connected: true,
    attributes,
    ...(rect.width || rect.height ? { bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } : {}),
  };
  if (input.operation === 'inspect') return { ok: true as const, node };
  const control = element as HTMLInputElement;
  if (input.operation === 'click') {
    if (control.disabled || element.getAttribute('aria-disabled') === 'true') {
      return { ok: false as const, code: 'node_not_actionable', message: '页面元素当前不可点击' };
    }
    const click = (element as HTMLElement).click;
    if (typeof click !== 'function') return { ok: false as const, code: 'node_not_actionable', message: '页面元素不支持原生 click 操作' };
    globalThis.setTimeout(() => click.call(element), 0);
  } else if (input.operation === 'focus') {
    if (!(element instanceof HTMLElement)) return { ok: false as const, code: 'node_not_actionable', message: '页面元素不支持聚焦' };
    element.focus({ preventScroll: true });
  } else if (input.operation === 'scroll') {
    element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  } else if (input.operation === 'setValue') {
    if (typeof input.value !== 'string') return { ok: false as const, code: 'invalid_node_action', message: 'setValue 缺少 value' };
    if (element instanceof HTMLInputElement) {
      if (element.type === 'file') return { ok: false as const, code: 'node_not_actionable', message: '不能通过 setValue 写入文件输入框' };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(element, input.value);
    } else if (element instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(element, input.value);
    } else if (element instanceof HTMLSelectElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(element, input.value);
    } else if (element instanceof HTMLElement && element.isContentEditable) {
      element.textContent = input.value;
    } else {
      return { ok: false as const, code: 'node_not_actionable', message: '页面元素不支持 setValue' };
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: input.value }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }
  return { ok: true as const, node };
}

async function operateNode(
  captureId: string,
  nodeId: string,
  operation: 'inspect' | PageNodeAction,
  input: BrowserTarget | number,
  value?: string,
): Promise<PageNodeDetails> {
  const target = await resolveDocumentTarget(input);
  const [{ result }] = await browser.scripting.executeScript({
    target: scriptingTarget(target),
    world: 'MAIN',
    func: operateRegisteredNode,
    args: [{ captureId, nodeId, operation, value }],
  });
  if (!result?.ok) throw new ExtensionError(result?.code || 'node_operation_failed', result?.message || '页面元素操作失败');
  return {
    ...(result.node as unknown as PageNodeSummary),
    connected: true,
    attributes: (result.node.attributes || {}) as Record<string, string>,
    bounds: result.node.bounds,
    reference: { captureId, nodeId, ...target },
  };
}

export function inspectPageNode(captureId: string, nodeId: string, input: BrowserTarget | number): Promise<PageNodeDetails> {
  return operateNode(captureId, nodeId, 'inspect', input);
}

export async function actOnPageNode(
  captureId: string,
  nodeId: string,
  action: PageNodeAction,
  input: BrowserTarget | number,
  value?: string,
): Promise<PageNodeActionResult> {
  const node = await operateNode(captureId, nodeId, action, input, value);
  return { action, completedAt: Date.now(), node };
}

export async function invokePageFunction(path: string, args: unknown[], input?: BrowserTarget | number, timeoutMs = 10_000): Promise<PageEvalResult> {
  const tab = await getTab(typeof input === 'number' ? input : input?.tabId);
  const target = await resolveDocumentTarget(input || tab.id);
  return executePageOperation(target, { operation: 'invoke', path, args }, timeoutMs);
}

export async function evalInPage(code: string, mode: 'expression' | 'program', input?: BrowserTarget | number, timeoutMs = 10_000): Promise<PageEvalResult> {
  if (!code.trim()) throw new Error('执行代码不能为空');
  const tab = await getTab(typeof input === 'number' ? input : input?.tabId);
  const target = await resolveDocumentTarget(input || tab.id);
  return executePageOperation(target, { operation: 'eval', mode, code }, timeoutMs);
}
