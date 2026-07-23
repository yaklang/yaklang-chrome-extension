import type { NormalizedProxyRule, ProxyRulePage } from '@/types/models';

const DATABASE_NAME = 'yakit-proxy-rules';
const DATABASE_VERSION = 1;
const CHUNK_SIZE = 512;
const SOURCE_STORE = 'source-revisions';
const RULE_STORE = 'rule-chunks';
const ARTIFACT_STORE = 'compiled-artifacts';
const MAX_COMPILED_ARTIFACTS = 8;

interface SourceRevisionRecord {
  key: string;
  sourceId: string;
  revision: string;
  content: string;
  ruleCount: number;
  createdAt: number;
}

interface RuleChunkRecord {
  key: string;
  sourceId: string;
  revision: string;
  index: number;
  rules: NormalizedProxyRule[];
}

export interface CompiledProxyArtifactRecord {
  revision: string;
  pacScript: string;
  compiledBytes: number;
  manualRuleCount: number;
  sourceRuleCount: number;
  warnings: string[];
  createdAt: number;
}

function revisionKey(sourceId: string, revision: string): string {
  return `${sourceId}:${revision}`;
}

function chunkKey(sourceId: string, revision: string, index: number): string {
  return `${revisionKey(sourceId, revision)}:${String(index).padStart(8, '0')}`;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB 事务已中止'));
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 事务失败'));
  });
}

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error('当前浏览器不支持 IndexedDB 规则仓库'));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SOURCE_STORE)) {
        const sources = database.createObjectStore(SOURCE_STORE, { keyPath: 'key' });
        sources.createIndex('sourceId', 'sourceId', { unique: false });
      }
      if (!database.objectStoreNames.contains(RULE_STORE)) {
        const chunks = database.createObjectStore(RULE_STORE, { keyPath: 'key' });
        chunks.createIndex('sourceId', 'sourceId', { unique: false });
        chunks.createIndex('sourceRevision', ['sourceId', 'revision'], { unique: false });
      }
      if (!database.objectStoreNames.contains(ARTIFACT_STORE)) {
        database.createObjectStore(ARTIFACT_STORE, { keyPath: 'revision' });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = undefined;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = undefined;
      reject(request.error || new Error('无法打开 IndexedDB 规则仓库'));
    };
    request.onblocked = () => {
      databasePromise = undefined;
      reject(new Error('规则仓库升级被其他扩展页面阻塞，请关闭 Options 后重试'));
    };
  });
  return databasePromise;
}

export async function putSourceRevision(
  sourceId: string,
  revision: string,
  content: string,
  rules: NormalizedProxyRule[],
): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction([SOURCE_STORE, RULE_STORE], 'readwrite');
  const sourceStore = transaction.objectStore(SOURCE_STORE);
  const ruleStore = transaction.objectStore(RULE_STORE);
  const sourceRecord: SourceRevisionRecord = {
    key: revisionKey(sourceId, revision), sourceId, revision, content, ruleCount: rules.length, createdAt: Date.now(),
  };
  sourceStore.put(sourceRecord);
  for (let index = 0; index * CHUNK_SIZE < rules.length; index += 1) {
    const record: RuleChunkRecord = {
      key: chunkKey(sourceId, revision, index), sourceId, revision, index,
      rules: rules.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
    };
    ruleStore.put(record);
  }
  await transactionDone(transaction);
}

export async function getSourceContent(sourceId: string, revision?: string): Promise<string | undefined> {
  if (!revision) return undefined;
  const database = await openDatabase();
  const transaction = database.transaction(SOURCE_STORE, 'readonly');
  const record = await requestResult(transaction.objectStore(SOURCE_STORE).get(revisionKey(sourceId, revision))) as SourceRevisionRecord | undefined;
  await transactionDone(transaction);
  return record?.content;
}

export async function getSourceRules(sourceId: string, revision?: string): Promise<NormalizedProxyRule[]> {
  if (!revision) return [];
  const database = await openDatabase();
  const transaction = database.transaction(RULE_STORE, 'readonly');
  const records = await requestResult(
    transaction.objectStore(RULE_STORE).index('sourceRevision').getAll(IDBKeyRange.only([sourceId, revision])),
  ) as RuleChunkRecord[];
  await transactionDone(transaction);
  return records.sort((left, right) => left.index - right.index).flatMap((record) => record.rules);
}

async function filteredRulePage(
  sourceId: string,
  revision: string,
  offset: number,
  limit: number,
  query: string,
): Promise<ProxyRulePage> {
  const database = await openDatabase();
  const transaction = database.transaction(RULE_STORE, 'readonly');
  const needle = query.trim().toLowerCase();
  let total = 0;
  const rules: NormalizedProxyRule[] = [];
  await new Promise<void>((resolve, reject) => {
    const request = transaction.objectStore(RULE_STORE).index('sourceRevision').openCursor(IDBKeyRange.only([sourceId, revision]));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const chunk = cursor.value as RuleChunkRecord;
      for (const rule of chunk.rules) {
        if (!`${rule.condition.type} ${rule.condition.value} ${rule.raw}`.toLowerCase().includes(needle)) continue;
        if (total >= offset && rules.length < limit) rules.push(rule);
        total += 1;
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error('无法搜索规则源'));
  });
  await transactionDone(transaction);
  return { sourceId, revision, offset, limit, total, rules };
}

export async function getSourceRulePage(
  sourceId: string,
  revision: string | undefined,
  offset: number,
  limit: number,
  query = '',
): Promise<ProxyRulePage> {
  if (!revision) return { sourceId, offset, limit, total: 0, rules: [] };
  if (query.trim()) return filteredRulePage(sourceId, revision, offset, limit, query);
  const database = await openDatabase();
  const transaction = database.transaction([SOURCE_STORE, RULE_STORE], 'readonly');
  const sourceRequest = transaction.objectStore(SOURCE_STORE).get(revisionKey(sourceId, revision));
  const startChunk = Math.floor(offset / CHUNK_SIZE);
  const endChunk = Math.floor(Math.max(offset, offset + limit - 1) / CHUNK_SIZE);
  const chunkRequests: Array<Promise<RuleChunkRecord | undefined>> = [];
  for (let index = startChunk; index <= endChunk; index += 1) {
    chunkRequests.push(requestResult(transaction.objectStore(RULE_STORE).get(chunkKey(sourceId, revision, index))) as Promise<RuleChunkRecord | undefined>);
  }
  const [source, chunks] = await Promise.all([
    requestResult(sourceRequest) as Promise<SourceRevisionRecord | undefined>,
    Promise.all(chunkRequests),
  ]);
  await transactionDone(transaction);
  const chunkOffset = offset - startChunk * CHUNK_SIZE;
  const rules = chunks.flatMap((chunk) => chunk?.rules || []).slice(chunkOffset, chunkOffset + limit);
  return { sourceId, revision, offset, limit, total: source?.ruleCount || 0, rules };
}

function deleteBySourceId(store: IDBObjectStore, sourceId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = store.index('sourceId').openKeyCursor(IDBKeyRange.only(sourceId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error('无法清理规则源数据'));
  });
}

export async function deleteSource(sourceId: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction([SOURCE_STORE, RULE_STORE], 'readwrite');
  await Promise.all([
    deleteBySourceId(transaction.objectStore(SOURCE_STORE), sourceId),
    deleteBySourceId(transaction.objectStore(RULE_STORE), sourceId),
  ]);
  await transactionDone(transaction);
}

export async function pruneSourceRevisions(sourceId: string, keepRevision: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction([SOURCE_STORE, RULE_STORE], 'readwrite');
  const pruneStore = (store: IDBObjectStore) => new Promise<void>((resolve, reject) => {
    const request = store.index('sourceId').openCursor(IDBKeyRange.only(sourceId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const value = cursor.value as SourceRevisionRecord | RuleChunkRecord;
      if (value.revision !== keepRevision) cursor.delete();
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error('无法清理旧规则 revision'));
  });
  await Promise.all([pruneStore(transaction.objectStore(SOURCE_STORE)), pruneStore(transaction.objectStore(RULE_STORE))]);
  await transactionDone(transaction);
}

export async function putCompiledArtifact(artifact: CompiledProxyArtifactRecord): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(ARTIFACT_STORE, 'readwrite');
  transaction.objectStore(ARTIFACT_STORE).put(artifact);
  await transactionDone(transaction);
  void pruneCompiledArtifacts().catch(() => undefined);
}

async function pruneCompiledArtifacts(): Promise<void> {
  const database = await openDatabase();
  const readTransaction = database.transaction(ARTIFACT_STORE, 'readonly');
  const artifacts = await requestResult(readTransaction.objectStore(ARTIFACT_STORE).getAll()) as CompiledProxyArtifactRecord[];
  await transactionDone(readTransaction);
  if (artifacts.length <= MAX_COMPILED_ARTIFACTS) return;
  const stale = artifacts.sort((left, right) => right.createdAt - left.createdAt).slice(MAX_COMPILED_ARTIFACTS);
  const writeTransaction = database.transaction(ARTIFACT_STORE, 'readwrite');
  const store = writeTransaction.objectStore(ARTIFACT_STORE);
  for (const artifact of stale) store.delete(artifact.revision);
  await transactionDone(writeTransaction);
}

export async function getCompiledArtifact(revision: string): Promise<CompiledProxyArtifactRecord | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction(ARTIFACT_STORE, 'readonly');
  const artifact = await requestResult(transaction.objectStore(ARTIFACT_STORE).get(revision)) as CompiledProxyArtifactRecord | undefined;
  await transactionDone(transaction);
  return artifact;
}

export { CHUNK_SIZE as PROXY_RULE_CHUNK_SIZE };
