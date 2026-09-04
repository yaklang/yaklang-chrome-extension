import { request } from '@/platform/messaging/runtime';

export type BrowserAuthorizationSide = 'left' | 'right';

export interface BrowserAuthorizationTarget {
  deviceId: string;
  tabId: number;
}

export interface BrowserAuthorizationPair {
  left: BrowserAuthorizationTarget;
  right: BrowserAuthorizationTarget;
}

export interface BrowserAuthorizationRequest {
  id: string;
  method: string;
  url: string;
  resourceType: string;
  startedAt: number;
  statusCode?: number;
}

export interface BrowserAuthorizationSelector {
  id: string;
  location: 'path' | 'query' | 'form' | 'json';
  path: string;
  label: string;
}

export interface BrowserAuthorizationPairInspection {
  method: string;
  route: string;
  sideEffect: boolean;
  selectors: BrowserAuthorizationSelector[];
  limitations: string[];
  blockedReason?: string;
}

export interface BrowserAuthorizationCaseResult {
  id: string;
  label: string;
  status: number;
  statusText: string;
  outcome: 'success' | 'denied' | 'redirect' | 'client-error' | 'server-error' | 'opaque';
  durationMs: number;
  contentType?: string;
  bodyBytes: number;
  matchesTarget?: boolean;
}

export interface BrowserAuthorizationResult {
  verdict: 'suspected' | 'possible' | 'protected' | 'inconclusive' | 'invalid-controls';
  summary: string;
  selector: BrowserAuthorizationSelector;
  cases: BrowserAuthorizationCaseResult[];
  limitations: string[];
}

export type BrowserAuthorizationTaskSchema =
  | 'authorization.capture.start'
  | 'authorization.capture.status'
  | 'authorization.capture.stop'
  | 'authorization.requests'
  | 'authorization.pair.inspect'
  | 'authorization.execute';

export async function runBrowserAuthorizationTask<T>(
  schema: BrowserAuthorizationTaskSchema,
  payload: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<T> {
  return request('authorization.engine.task', { schema, payload, timeoutMs }) as Promise<T>;
}
