import { browser } from 'wxt/browser';
import type {
  BrowserTransformDirectionName,
  BrowserTransformPacket,
} from '@/types/models';

/**
 * Replay bodies can contain credentials and tokens. Keep them behind per-draft
 * storage keys so they never become part of a portable transform profile or a
 * Bridge/RPC contract.
 */
const REPLAY_DRAFT_STORAGE_PREFIX = 'browser-transform-replay-draft.v1.';

export const MAX_BROWSER_TRANSFORM_REPLAY_DRAFT_BYTES = 256 * 1024;

export interface BrowserTransformReplaySample {
  body: string;
  label: string;
}

export interface BrowserTransformReplayDraftFields {
  method: string;
  url: string;
  headers: string;
  body: string;
  sample?: BrowserTransformReplaySample;
}

export interface BrowserTransformReplayDraft extends BrowserTransformReplayDraftFields {
  version: 1;
  profileId: string;
  direction: BrowserTransformDirectionName;
  origin: string;
  updatedAt: number;
}

export type BrowserTransformReplayDraftInput = Omit<BrowserTransformReplayDraft, 'version' | 'updatedAt'>;

export type BrowserTransformReplayDraftSaveResult =
  | { status: 'saved'; draft: BrowserTransformReplayDraft; bytes: number }
  | { status: 'too-large'; bytes: number; maxBytes: number };

const mutationQueues = new Map<string, Promise<void>>();

async function enqueueMutation<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) || Promise.resolve();
  const result = previous.then(task);
  const settled = result.then(() => undefined, () => undefined);
  mutationQueues.set(key, settled);
  try {
    return await result;
  } finally {
    if (mutationQueues.get(key) === settled) mutationQueues.delete(key);
  }
}

function replayDraftStorageKey(profileId: string, direction: BrowserTransformDirectionName): string {
  if (!profileId || profileId.length > 160) throw new Error('本地回放缺少有效的明文网关 ID');
  return `${REPLAY_DRAFT_STORAGE_PREFIX}${encodeURIComponent(profileId)}.${direction}`;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function parseReplayDraft(value: unknown): BrowserTransformReplayDraft | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<BrowserTransformReplayDraft>;
  if (candidate.version !== 1
    || !isString(candidate.profileId)
    || (candidate.direction !== 'request' && candidate.direction !== 'response')
    || !isString(candidate.origin)
    || !isString(candidate.method)
    || !isString(candidate.url)
    || !isString(candidate.headers)
    || !isString(candidate.body)
    || typeof candidate.updatedAt !== 'number'
    || !Number.isFinite(candidate.updatedAt)) return undefined;
  if (candidate.sample !== undefined && (!candidate.sample
    || !isString(candidate.sample.body)
    || !isString(candidate.sample.label))) return undefined;
  return candidate as BrowserTransformReplayDraft;
}

function replayDraftBytes(value: BrowserTransformReplayDraftInput): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export async function getBrowserTransformReplayDraft(
  profileId: string,
  direction: BrowserTransformDirectionName,
  origin: string,
): Promise<BrowserTransformReplayDraft | undefined> {
  const key = replayDraftStorageKey(profileId, direction);
  await mutationQueues.get(key);
  const stored = (await browser.storage.local.get(key))[key];
  const draft = parseReplayDraft(stored);
  if (!draft || draft.profileId !== profileId || draft.direction !== direction || draft.origin !== origin) {
    if (stored !== undefined) await enqueueMutation(key, async () => {
      const latest = (await browser.storage.local.get(key))[key];
      const latestDraft = parseReplayDraft(latest);
      if (!latestDraft || latestDraft.profileId !== profileId
        || latestDraft.direction !== direction || latestDraft.origin !== origin) {
        await browser.storage.local.remove(key);
      }
    });
    return undefined;
  }
  return draft;
}

export async function saveBrowserTransformReplayDraft(
  input: BrowserTransformReplayDraftInput,
): Promise<BrowserTransformReplayDraftSaveResult> {
  const key = replayDraftStorageKey(input.profileId, input.direction);
  return enqueueMutation(key, async () => {
    const bytes = replayDraftBytes(input);
    if (bytes > MAX_BROWSER_TRANSFORM_REPLAY_DRAFT_BYTES) {
      // Do not leave an older, now misleading draft behind when the current one
      // cannot be persisted in full.
      await browser.storage.local.remove(key);
      return { status: 'too-large', bytes, maxBytes: MAX_BROWSER_TRANSFORM_REPLAY_DRAFT_BYTES };
    }
    const draft: BrowserTransformReplayDraft = {
      ...structuredClone(input),
      version: 1,
      updatedAt: Date.now(),
    };
    await browser.storage.local.set({ [key]: draft });
    return { status: 'saved', draft, bytes };
  });
}

export async function clearBrowserTransformReplayDraft(
  profileId: string,
  direction: BrowserTransformDirectionName,
): Promise<void> {
  const key = replayDraftStorageKey(profileId, direction);
  await enqueueMutation(key, () => browser.storage.local.remove(key));
}

export async function deleteBrowserTransformReplayDrafts(profileId: string): Promise<void> {
  await Promise.all([
    clearBrowserTransformReplayDraft(profileId, 'request'),
    clearBrowserTransformReplayDraft(profileId, 'response'),
  ]);
}

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function browserTransformReplayDraftToPacket(
  draft: BrowserTransformReplayDraft,
): BrowserTransformPacket {
  const method = draft.method.trim().toUpperCase();
  if (!/^[A-Z]{1,16}$/.test(method)) {
    throw new Error('本地回放草稿的 HTTP 方法无效');
  }
  let url: URL;
  try {
    url = new URL(draft.url);
  } catch {
    throw new Error('本地回放草稿的 URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== draft.origin || url.hash) {
    throw new Error('本地回放草稿必须保持在明文网关绑定的 HTTP(S) 来源内');
  }
  let parsedHeaders: unknown;
  try {
    parsedHeaders = JSON.parse(draft.headers);
  } catch {
    throw new Error('本地回放草稿的 Header 必须是 JSON 对象');
  }
  if (!parsedHeaders || typeof parsedHeaders !== 'object' || Array.isArray(parsedHeaders)) {
    throw new Error('本地回放草稿的 Header 必须是 JSON 对象');
  }
  const headers = Object.entries(parsedHeaders as Record<string, unknown>).map(([rawName, rawValue]) => {
    const name = rawName.trim();
    const value = rawValue === null ? '' : String(rawValue);
    if (
      !name
      || name.length > 256
      || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
      || value.length > 16_384
      || /[\r\n]/.test(value)
    ) {
      throw new Error(`本地回放草稿包含无效 Header: ${rawName}`);
    }
    return { name, value };
  });
  if (headers.length > 256) {
    throw new Error('本地回放草稿最多包含 256 个 Header');
  }
  return {
    method,
    url: url.toString(),
    headers,
    bodyBase64: encodeUtf8Base64(draft.body),
  };
}
