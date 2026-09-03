import { browser, type Browser } from 'wxt/browser';
import { setAgentRuntimeState } from '@/features/agent-runtime/service';
import { browserInstanceAccess } from '@/features/grants/capability-context';
import { activateTab, getTab, resolveDocumentTarget, scriptingTarget } from '@/platform/browser/targets';
import { getState, updateState } from '@/platform/storage/state';
import { ExtensionError } from '@/shared/errors';
import type { BridgeGrant, HandoffState, HumanHandoff } from '@/types/models';

const MAX_PRESENTATION_BYTES = 1024 * 1024;
const SAFE_RASTER_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,/i;

interface PageQrCandidate {
  dataUrl?: string;
  source: 'image' | 'canvas' | 'svg' | 'background' | 'screenshot';
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number; devicePixelRatio: number };
  title: string;
  url: string;
}

export interface HandoffPresentation {
  handoffId: string;
  state: HandoffState | 'not_found' | 'page_changed';
  title: string;
  url: string;
  capturedAt: number;
  source?: PageQrCandidate['source'];
  dataUrl?: string;
}

async function resolvePresentationTarget(target: HumanHandoff['target']) {
  try {
    return await resolveDocumentTarget(target);
  } catch (error) {
    if (!(error instanceof ExtensionError) || !['stale_document', 'target_unavailable'].includes(error.code)) throw error;
  }

  const frame = await browser.webNavigation.getFrame({
    tabId: target.tabId,
    frameId: target.frameId,
  }).catch(() => null);
  if (!frame?.url || !/^https?:/i.test(frame.url) || new URL(frame.url).origin !== target.origin) return undefined;
  return resolveDocumentTarget({ tabId: target.tabId, frameId: target.frameId }).catch(() => undefined);
}

function dataUrlBytes(value: string): number {
  const comma = value.indexOf(',');
  return comma < 0 ? Number.MAX_SAFE_INTEGER : Math.ceil((value.length - comma - 1) * 0.75);
}

export function isSafeHandoffPresentationDataUrl(value: unknown): value is string {
  return typeof value === 'string'
    && SAFE_RASTER_DATA_URL.test(value)
    && dataUrlBytes(value) <= MAX_PRESENTATION_BYTES;
}

async function findQrCandidateInPage(): Promise<PageQrCandidate | undefined> {
  const resolvePresentationDataUrl = async (source: string, width: number, height: number): Promise<string | undefined> => {
    const rasterize = async (url: string): Promise<string | undefined> => {
      const image = new Image();
      image.decoding = 'async';
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('image load failed'));
        image.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(1024, Math.max(1, image.naturalWidth || Math.round(width)));
      canvas.height = Math.min(1024, Math.max(1, image.naturalHeight || Math.round(height)));
      canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    };

    try {
      if (/^data:image\/(?:png|jpeg|webp);base64,/i.test(source)) return source;
      if (/^data:image\/svg\+xml/i.test(source)) return rasterize(source);
      if (!/^(?:blob:|https?:)/i.test(source)) return undefined;
      const response = await fetch(source);
      if (!response.ok) return undefined;
      const blob = await response.blob();
      if (blob.size > 1024 * 1024) return undefined;
      const localUrl = URL.createObjectURL(blob);
      try {
        if (/^image\/(?:png|jpeg|webp)$/i.test(blob.type)) {
          return await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
        }
        if (blob.type === 'image/svg+xml') return await rasterize(localUrl);
      } finally {
        URL.revokeObjectURL(localUrl);
      }
    } catch {
      return undefined;
    }
    return undefined;
  };

  const keywords = /(?:^|[^a-z])(qr|qrcode|scan)(?:[^a-z]|$)|二维码|扫码|扫码登录/i;
  const selector = 'img,canvas,svg,[role="img"],[class*="qr" i],[id*="qr" i]';
  const seen = new Set<Element>();
  const candidates: Array<{ element: Element; score: number; rect: DOMRect }> = [];

  for (const element of document.querySelectorAll(selector)) {
    if (seen.has(element)) continue;
    seen.add(element);
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (
      rect.width < 96 || rect.height < 96
      || rect.bottom <= 0 || rect.right <= 0
      || rect.top >= innerHeight || rect.left >= innerWidth
      || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0
    ) continue;
    const ratio = rect.width / rect.height;
    if (ratio < 0.72 || ratio > 1.38) continue;

    const ownText = [
      element.id,
      element.getAttribute('class'),
      element.getAttribute('alt'),
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
    ].filter(Boolean).join(' ');
    let contextText = '';
    let parent: Element | null = element;
    for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
      contextText += ` ${parent.textContent || ''}`;
      if (contextText.length >= 500) break;
    }
    const inDialog = Boolean(element.closest('dialog,[role="dialog"],[aria-modal="true"]'));
    const score = (keywords.test(ownText) ? 8 : 0)
      + (keywords.test(contextText.slice(0, 500)) ? 5 : 0)
      + (Math.abs(1 - ratio) < 0.12 ? 4 : 2)
      + (inDialog ? 2 : 0)
      + (element instanceof HTMLCanvasElement || element instanceof SVGElement ? 1 : 0);
    if (score >= 6) candidates.push({ element, score, rect });
  }

  candidates.sort((left, right) => right.score - left.score || right.rect.width - left.rect.width);
  for (const { element, rect } of candidates.slice(0, 8)) {
    let source: PageQrCandidate['source'] = 'screenshot';
    let dataUrl: string | undefined;
    try {
      if (element instanceof HTMLCanvasElement) {
        source = 'canvas';
        dataUrl = element.toDataURL('image/png');
      } else if (element instanceof SVGElement) {
        source = 'svg';
        const svg = new XMLSerializer().serializeToString(element);
        dataUrl = await resolvePresentationDataUrl(
          `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
          rect.width,
          rect.height,
        );
      } else {
        const imageSource = element instanceof HTMLImageElement
          ? element.currentSrc || element.src
          : getComputedStyle(element).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1] || '';
        source = element instanceof HTMLImageElement ? 'image' : 'background';
        dataUrl = await resolvePresentationDataUrl(imageSource, rect.width, rect.height);
      }
    } catch {
      dataUrl = undefined;
    }
    return {
      dataUrl,
      source: dataUrl ? source : 'screenshot',
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio: devicePixelRatio || 1 },
      title: document.title,
      url: location.href,
    };
  }
  return undefined;
}

async function cropVisibleTab(
  tab: Awaited<ReturnType<typeof getTab>>,
  candidate: PageQrCandidate,
): Promise<string | undefined> {
  if (!tab.active || typeof OffscreenCanvas === 'undefined') return undefined;
  const screenshot = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const bitmap = await createImageBitmap(await (await fetch(screenshot)).blob());
  const scaleX = bitmap.width / candidate.viewport.width;
  const scaleY = bitmap.height / candidate.viewport.height;
  const padding = 12;
  const x = Math.max(0, Math.floor((candidate.rect.x - padding) * scaleX));
  const y = Math.max(0, Math.floor((candidate.rect.y - padding) * scaleY));
  const width = Math.min(bitmap.width - x, Math.ceil((candidate.rect.width + padding * 2) * scaleX));
  const height = Math.min(bitmap.height - y, Math.ceil((candidate.rect.height + padding * 2) * scaleY));
  if (width < 1 || height < 1) return undefined;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
  bitmap.close();
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  if (bytes.byteLength > MAX_PRESENTATION_BYTES) return undefined;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

export async function getHandoffPresentation(handoffId: string, grant: BridgeGrant): Promise<HandoffPresentation> {
  const handoff = (await getState()).handoff;
  if (!handoff || handoff.id !== handoffId || handoff.taskId !== grant.taskId) {
    throw new ExtensionError('handoff_not_found', '人工接管请求不存在');
  }
  const base = {
    handoffId,
    state: handoff.state,
    title: handoff.target.title || '',
    url: handoff.target.grantedUrl || '',
    capturedAt: Date.now(),
  };
  if (handoff.state !== 'waiting_for_user' || handoff.reason !== 'qr_code') return base;

  const target = await resolvePresentationTarget(handoff.target);
  if (!target) return { ...base, state: 'page_changed' };
  const tab = await getTab(target.tabId);
  const results = await browser.scripting.executeScript({
    target: scriptingTarget(target),
    world: 'MAIN',
    func: findQrCandidateInPage,
  }) as Array<Browser.scripting.InjectionResult<PageQrCandidate | undefined>>;
  if (results.length !== 1 || !results[0]?.result) return { ...base, state: 'not_found' };

  const candidate = results[0].result;
  const directDataUrl = isSafeHandoffPresentationDataUrl(candidate.dataUrl) ? candidate.dataUrl : undefined;
  const dataUrl = directDataUrl
    ? directDataUrl
    : target.frameId === 0
      ? await cropVisibleTab(tab, candidate).catch(() => undefined)
      : undefined;
  if (!isSafeHandoffPresentationDataUrl(dataUrl)) {
    return { ...base, state: 'not_found', title: candidate.title || base.title, url: candidate.url || base.url };
  }
  return {
    ...base,
    state: 'waiting_for_user',
    title: candidate.title || base.title,
    url: candidate.url || base.url,
    source: directDataUrl ? candidate.source : 'screenshot',
    dataUrl,
  };
}

export async function focusHandoff(handoffId: string, grant: BridgeGrant): Promise<{ focused: true; tabId: number }> {
  const handoff = (await getState()).handoff;
  if (
    !handoff
    || handoff.id !== handoffId
    || handoff.taskId !== grant.taskId
    || handoff.state !== 'waiting_for_user'
  ) {
    throw new ExtensionError('handoff_not_waiting', '人工接管请求不存在或已经结束');
  }
  await activateTab(handoff.target.tabId);
  return { focused: true, tabId: handoff.target.tabId };
}

export async function resolveHandoff(
  handoffId: string,
  outcome: Extract<HandoffState, 'completed' | 'cancelled'>,
  grant?: BridgeGrant,
): Promise<{ state: Awaited<ReturnType<typeof getState>>; handoff: HumanHandoff }> {
  const state = await updateState((current) => {
    if (
      !current.handoff
      || current.handoff.id !== handoffId
      || current.handoff.state !== 'waiting_for_user'
      || (grant && current.handoff.taskId !== grant.taskId)
    ) {
      throw new ExtensionError('handoff_not_waiting', '人工接管请求不存在或已经结束');
    }
    return {
      ...current,
      handoff: { ...current.handoff, state: outcome, resolvedAt: Date.now() },
    };
  });
  const handoff = state.handoff!;
  await setAgentRuntimeState(
    outcome === 'completed' ? 'running' : 'paused',
    grant || await browserInstanceAccess('browser.tabs.read'),
  );
  await browser.action.setBadgeText({
    text: state.bridge.managedInstance?.badge || '',
    tabId: handoff.target.tabId,
  }).catch(() => undefined);
  return { state, handoff };
}
