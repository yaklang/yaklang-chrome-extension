import { browser, type Browser } from 'wxt/browser';
import type { BrowserTarget } from '@/types/models';
import { ExtensionError } from '@/shared/errors';
import { resolveDocumentTarget } from '@/platform/browser/targets';

export function isFloatingSender(sender: Browser.runtime.MessageSender): boolean {
  try {
    const parsed = new URL(sender.url || '');
    return parsed.origin === new URL(browser.runtime.getURL('/')).origin
      && parsed.pathname === '/floating.html';
  } catch {
    return false;
  }
}

export function senderBoundTabId(sender: Browser.runtime.MessageSender): number | undefined {
  const extensionOrigin = new URL(browser.runtime.getURL('/')).origin;
  const senderUrl = sender.url || '';
  try {
    const parsed = new URL(senderUrl);
    if (parsed.origin === extensionOrigin && parsed.pathname !== '/floating.html') return undefined;
  } catch {
    // Non-URL senders remain bound to their browser tab below.
  }
  return sender.tab?.id;
}

export function targetTabId(
  requested: number | undefined,
  sender: Browser.runtime.MessageSender,
): number | undefined {
  const senderTabId = senderBoundTabId(sender);
  if (senderTabId && requested && senderTabId !== requested) {
    throw new ExtensionError('target_denied', '页面内请求不能操作其他标签页');
  }
  return senderTabId || requested;
}

export async function requestTarget(
  input: { tabId?: number; frameId?: number; documentId?: string },
  sender: Browser.runtime.MessageSender,
): Promise<BrowserTarget | undefined> {
  const boundTabId = senderBoundTabId(sender);
  if (boundTabId && input.tabId && boundTabId !== input.tabId) {
    throw new ExtensionError('target_denied', '页面内请求不能操作其他标签页');
  }
  if (boundTabId && !isFloatingSender(sender)) {
    const frameId = sender.frameId ?? 0;
    if (input.frameId !== undefined && input.frameId !== frameId) {
      throw new ExtensionError('target_denied', '页面内请求不能操作其他 frame');
    }
    if (input.documentId && sender.documentId && input.documentId !== sender.documentId) {
      throw new ExtensionError('stale_document', '目标页面已经刷新或导航，请重新选择');
    }
    return { tabId: boundTabId, frameId, documentId: sender.documentId };
  }
  const tabId = boundTabId || input.tabId;
  if (!tabId) return undefined;
  return resolveDocumentTarget({
    tabId,
    frameId: input.frameId ?? 0,
    documentId: input.documentId,
  });
}

export async function requiredRequestTarget(
  input: { tabId?: number; frameId?: number; documentId?: string },
  sender: Browser.runtime.MessageSender,
): Promise<BrowserTarget> {
  const target = await requestTarget(input, sender);
  if (!target) {
    throw new ExtensionError('target_unavailable', '请选择一个可访问的 HTTP(S) 标签页');
  }
  return target;
}

export async function requiredDebuggerTarget(
  input: { tabId?: number; frameId?: number; documentId?: string },
  sender: Browser.runtime.MessageSender,
): Promise<BrowserTarget> {
  const boundTabId = senderBoundTabId(sender);
  if (boundTabId && input.tabId && boundTabId !== input.tabId) {
    throw new ExtensionError('target_denied', '页面内请求不能操作其他标签页');
  }
  const tabId = boundTabId || input.tabId;
  if (!tabId) {
    throw new ExtensionError('target_unavailable', '请选择一个可访问的 HTTP(S) 标签页');
  }
  const frameId = boundTabId && !isFloatingSender(sender)
    ? sender.frameId ?? 0
    : input.frameId ?? 0;
  if (boundTabId && !isFloatingSender(sender)
    && input.frameId !== undefined && input.frameId !== frameId) {
    throw new ExtensionError('target_denied', '页面内请求不能操作其他 frame');
  }
  const frame = await browser.webNavigation.getFrame({ tabId, frameId });
  if (!frame) throw new ExtensionError('target_unavailable', '目标 frame 已不存在');
  if (input.documentId && frame.documentId && input.documentId !== frame.documentId) {
    throw new ExtensionError('stale_document', '目标页面已经刷新或导航');
  }
  return { tabId, frameId, documentId: frame.documentId || input.documentId };
}
