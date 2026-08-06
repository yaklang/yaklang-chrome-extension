import type {
  ActiveTabInfo,
  BrowserPageCallable,
  BrowserProfileInferenceCandidate,
  BrowserRecordingEvent,
  BrowserTransformDirection,
  BrowserTransformProfileInput,
} from '@/types/models';
import { compileGuidedTransform, defaultGuidedTransform, type GuidedTransformOutputKind } from './guided';

interface RequestRouteSource {
  url?: string;
  method?: string;
}

function originOf(url?: string): string {
  try { return url ? new URL(url).origin : ''; } catch { return ''; }
}

function routeOf(event?: RequestRouteSource, tab?: ActiveTabInfo): string {
  const value = event?.url || tab?.url;
  try { return value ? `*${new URL(value, tab?.url).pathname}` : '*'; } catch { return '*'; }
}

function emptyDirection(enabled = false): BrowserTransformDirection {
  return { enabled, nodes: [] };
}

function candidateGuidance(candidate?: BrowserProfileInferenceCandidate): {
  inputPaths?: string[];
  outputKind?: GuidedTransformOutputKind;
  outputField?: string;
} {
  const destination = candidate?.request.destination;
  const serialization = candidate?.request.serialization;
  if (!destination) return {};
  if (candidate?.direction === 'response') {
    return { inputPaths: [destination], outputKind: 'body' };
  }
  if (serialization === 'form-field') return { outputKind: 'form-field', outputField: destination.slice(5) };
  if (serialization === 'json-field') return { outputKind: 'json-field', outputField: destination.slice(5) };
  if (serialization === 'header') return { outputKind: 'header', outputField: destination.slice(7) };
  if (serialization === 'query') return { outputKind: 'query', outputField: destination.slice(6) };
  return { outputKind: 'body' };
}

export function createBrowserTransformProfileInput(
  tab: ActiveTabInfo,
  event?: BrowserRecordingEvent,
  callable?: BrowserPageCallable,
  candidate?: BrowserProfileInferenceCandidate,
): BrowserTransformProfileInput {
  const guide = defaultGuidedTransform(callable, candidateGuidance(candidate));
  const compiled = callable ? compileGuidedTransform(guide, callable) : emptyDirection(true);
  const responseDirection = candidate?.direction === 'response';
  const routeEvent = candidate ? {
    url: candidate.request.url,
    method: candidate.request.method,
  } : event;
  return {
    name: routeEvent?.url
      ? `${routeEvent.method || 'HTTP'} ${routeOf(routeEvent, tab)} ${responseDirection ? '响应' : '请求'}明文网关`
      : `${tab.title || '当前页面'} 明文网关`,
    enabled: true,
    target: { tabId: tab.id, frameId: 0 },
    origin: originOf(tab.url),
    match: { methods: routeEvent?.method ? [routeEvent.method.toUpperCase()] : ['POST'], urlPattern: routeOf(routeEvent, tab) },
    request: responseDirection ? emptyDirection(false) : compiled,
    response: responseDirection ? compiled : emptyDirection(false),
    failMode: 'closed',
    maxConcurrency: callable?.kind === 'request-transaction' ? 1 : 2,
  };
}
