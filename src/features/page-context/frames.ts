import { browser, type Browser } from 'wxt/browser';
import type { PageFrameSummary } from '@/types/models';

interface FrameProbe {
  title: string;
  name: string;
  origin: string;
  url: string;
  readyState: string;
  sandbox: string[];
}

type FrameProbeResult = Browser.scripting.InjectionResult<FrameProbe> & { documentId?: string };

function probeFrame(): FrameProbe {
  let sandbox: string[] = [];
  try {
    sandbox = Array.from(window.frameElement?.getAttribute('sandbox')?.split(/\s+/).filter(Boolean) || []).slice(0, 32);
  } catch {
    // Cross-origin parent access is not required for frame inventory.
  }
  return {
    title: document.title.slice(0, 1_000),
    name: window.name.slice(0, 240),
    origin: location.origin,
    url: location.href.slice(0, 8_192),
    readyState: document.readyState,
    sandbox,
  };
}

function urlOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : '';
  } catch {
    return '';
  }
}

export async function getFrameInventory(tabId: number): Promise<PageFrameSummary[]> {
  const [navigationFrames, probeResults] = await Promise.all([
    browser.webNavigation.getAllFrames({ tabId }).catch(() => null),
    browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: probeFrame,
    }).catch(() => [] as FrameProbeResult[]),
  ]);
  const probes = new Map((probeResults as FrameProbeResult[]).map((probe) => [probe.frameId, probe]));
  const navigation = navigationFrames || [];
  const frameIds = new Set<number>([...navigation.map((frame) => frame.frameId), ...probes.keys()]);
  const topNavigation = navigation.find((frame) => frame.frameId === 0);
  const topProbe = probes.get(0)?.result;
  const topOrigin = topProbe?.origin && topProbe.origin !== 'null' ? topProbe.origin : urlOrigin(topNavigation?.url || topProbe?.url || '');
  return [...frameIds].sort((left, right) => left - right).slice(0, 256).map((frameId) => {
    const navigationFrame = navigation.find((frame) => frame.frameId === frameId);
    const injection = probes.get(frameId);
    const probe = injection?.result;
    const url = probe?.url || navigationFrame?.url || '';
    const detectedOrigin = probe?.origin && probe.origin !== 'null' ? probe.origin : urlOrigin(url);
    const origin = detectedOrigin || (navigationFrame?.parentFrameId === 0 && /^about:(blank|srcdoc)/.test(url) ? topOrigin : '');
    return {
      tabId,
      frameId,
      documentId: injection?.documentId || navigationFrame?.documentId,
      parentFrameId: navigationFrame?.parentFrameId ?? (frameId === 0 ? -1 : 0),
      parentDocumentId: navigationFrame?.parentDocumentId,
      url,
      origin,
      title: probe?.title || (frameId === 0 ? 'Main frame' : `Frame ${frameId}`),
      name: probe?.name || '',
      frameType: String(navigationFrame?.frameType || (frameId === 0 ? 'outermost_frame' : 'sub_frame')),
      documentLifecycle: String(navigationFrame?.documentLifecycle || 'active'),
      isTop: frameId === 0,
      sameOrigin: Boolean(origin && topOrigin && origin === topOrigin),
      accessible: Boolean(injection?.result),
      sandbox: probe?.sandbox || [],
    };
  });
}
