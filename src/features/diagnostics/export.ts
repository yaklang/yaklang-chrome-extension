import { browser } from 'wxt/browser';
import { STATE_STORAGE_KEYS } from '@/protocol/storage';
import type { BridgeStatus, DiagnosticsBundle } from '@/types/models';
import { listAuditEvents } from '@/features/diagnostics/audit';
import { getState } from '@/platform/storage/state';
import { getEnterprisePolicy } from '@/platform/policy/managed';
import { getRuntimeMetrics } from './metrics';

export async function createDiagnosticsBundle(bridge: BridgeStatus): Promise<DiagnosticsBundle> {
  const manifest = browser.runtime.getManifest();
  const sessionArea = (browser.storage as unknown as { session?: { get(keys: string[]): Promise<Record<string, unknown>> } }).session;
  const [state, platform, policy, metrics, audit, local, session] = await Promise.all([
    getState(), browser.runtime.getPlatformInfo(), getEnterprisePolicy(), getRuntimeMetrics(), listAuditEvents(100),
    browser.storage.local.get([...STATE_STORAGE_KEYS]),
    sessionArea?.get([...STATE_STORAGE_KEYS]) || Promise.resolve({}),
  ]);
  const { taskId: _taskId, grantId: _grantId, ...safeBridge } = bridge;
  return {
    schemaVersion: 1,
    generatedAt: Date.now(),
    extension: {
      version: manifest.version,
      manifestVersion: manifest.manifest_version,
      buildChannel: import.meta.env.MODE,
      permissions: [...(manifest.permissions || [])].sort(),
    },
    platform: { os: platform.os, arch: platform.arch },
    bridge: safeBridge,
    policy,
    state: {
      proxyProfiles: state.proxyProfiles.length,
      proxyRules: state.proxyRules.length,
      proxyRuleSources: state.proxyRuleSources.length,
      proxySourceRules: state.proxyRuleSources.reduce((total, source) => total + source.supportedRuleCount, 0),
      proxyCompiledBytes: state.proxyRuntime.compiledBytes,
      proxyConfigurationDirty: state.proxyRuntime.dirty,
      customUserAgentProfiles: state.customUserAgentProfiles.length,
      userAgentAssignments: state.userAgentAssignments.length,
      floatingPanelEnabled: state.floatingPanel.enabled,
      activeGrant: Boolean(state.activeGrant),
      activeGrantTargets: state.activeGrant?.targets.length || 0,
      activeGrantScopes: state.activeGrant?.scopes || [],
      handoffState: state.handoff?.state,
    },
    storageDomains: Object.fromEntries(STATE_STORAGE_KEYS.map((key) => [key, key in local || key in session])),
    metrics,
    recentAudit: audit.map(({ timestamp, category, action, outcome, durationMs, errorCode }) => ({
      timestamp, category, action, outcome, durationMs, errorCode,
    })),
  };
}
