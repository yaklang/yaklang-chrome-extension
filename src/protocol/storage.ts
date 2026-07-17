export const PROXY_SETTINGS_STORAGE_KEY = 'settings.proxy.v1';
export const USER_AGENT_SETTINGS_STORAGE_KEY = 'settings.user-agent.v1';
export const BRIDGE_SETTINGS_STORAGE_KEY = 'settings.bridge.v2';
export const FLOATING_UI_STORAGE_KEY = 'ui.floating-panel.v1';
export const ACTIVE_SESSION_STORAGE_KEY = 'session.browser-agent.v1';
export const BRIDGE_SESSION_STORAGE_KEY = 'session.bridge.v1';
export const AGENT_RUNTIME_STORAGE_KEY = 'session.agent-runtime.v1';
export const STATE_STORAGE_KEYS = [
  PROXY_SETTINGS_STORAGE_KEY,
  USER_AGENT_SETTINGS_STORAGE_KEY,
  BRIDGE_SETTINGS_STORAGE_KEY,
  FLOATING_UI_STORAGE_KEY,
  ACTIVE_SESSION_STORAGE_KEY,
  BRIDGE_SESSION_STORAGE_KEY,
  AGENT_RUNTIME_STORAGE_KEY,
] as const;

export function isStateStorageChange(changes: Record<string, unknown>): boolean {
  return STATE_STORAGE_KEYS.some((key) => key in changes);
}
export const AUDIT_STORAGE_KEY = 'yakit-audit-log-v1';
export const NETWORK_CAPTURE_STORAGE_KEY = 'yakit-network-capture-v1';
export const CONTEXT_DIGEST_STORAGE_KEY = 'yakit-context-digests-v1';
export const PAGE_LIFECYCLE_STORAGE_KEY = 'yakit-page-lifecycle-v1';
export const PROXY_AUTH_STORAGE_KEY = 'yakit-proxy-auth-v1';
export const PROXY_STATS_STORAGE_KEY = 'yakit-proxy-stats-v1';
export const RUNTIME_METRICS_STORAGE_KEY = 'runtime.metrics.v1';
