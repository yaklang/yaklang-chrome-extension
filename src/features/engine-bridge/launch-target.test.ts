import { describe, expect, it } from 'vitest';
import { bindLaunchTarget, normalizeLaunchTarget, selectLaunchTarget } from './launch-target';
import type { BridgeConfig, BridgeLaunchTarget, BridgePairedEngine, DiscoveredYakEngine } from '@/types/models';

const target: BridgeLaunchTarget = { mode: 'engine', frontendId: 'memfit', frontendName: 'Memfit AI',
  engineIdentityId: 'memfit-key', engineInstanceId: 'memfit-process', endpoint: 'ws://127.0.0.1:14333/extension' };
const memfit: DiscoveredYakEngine = { protocolVersion: 3, frontendId: 'memfit', frontendName: 'Memfit AI',
  engineIdentityId: 'memfit-key', engineInstanceId: 'memfit-process', endpoint: target.endpoint! };

describe('YTray selected frontend', () => {
  it('remembers trusted frontend pairings without reusing another frontend device registration', () => {
    const pair: BridgePairedEngine = { engineIdentityId: 'shared-key', frontendId: 'yakit', deviceId: 'device-yakit',
      publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, pairedAt: 1 };
    const config: BridgeConfig = { transport: 'websocket', nativeHost: '', endpoint: 'ws://127.0.0.1:64333/extension',
      autoConnect: true, installationId: 'stable-browser', pairedEngine: pair };
    const selected = { ...target, engineIdentityId: 'shared-key' };
    const memfitConfig = bindLaunchTarget(config, selected);
    expect(memfitConfig.installationId).toBe('stable-browser');
    expect(memfitConfig.pairedEngine).toBeUndefined();
    expect(memfitConfig.trustedEngines).toContainEqual(pair);
    const back = bindLaunchTarget({ ...memfitConfig, pairedEngine: { ...pair, frontendId: 'memfit', deviceId: 'device-memfit' } },
      { ...selected, frontendId: 'yakit', frontendName: 'Yakit', endpoint: config.endpoint });
    expect(back.pairedEngine?.deviceId).toBe('device-yakit');
    expect(config.pairedEngine?.deviceId).toBe('device-yakit');
    const none = bindLaunchTarget(back, { mode: 'none' });
    expect(none.autoConnect).toBe(false);
    expect(none.pairedEngine).toBeUndefined();
    expect(none.trustedEngines).toHaveLength(2);
  });
  it('selects Memfit even when Yakit occupies the default port and is discovered first', () => {
    expect(selectLaunchTarget(target, [{ ...memfit, frontendId: 'yakit', engineIdentityId: 'yakit-key',
      engineInstanceId: 'yakit-process', endpoint: 'ws://127.0.0.1:64333/extension' }, memfit])).toEqual(memfit);
  });
  it('waits for the selected frontend instead of moving to another available engine', () => {
    expect(() => selectLaunchTarget(target, [{ ...memfit, frontendId: 'yakit', engineIdentityId: 'yakit-key' }])).toThrow('等待');
  });
  it('distinguishes frontends sharing one persisted engine identity', () => {
    expect(() => selectLaunchTarget(target, [{ ...memfit, frontendId: 'yakit' }])).toThrow('等待');
  });
  it('follows a unique restart of the same selected frontend, but refuses an ambiguous replacement', () => {
    const restarted = { ...memfit, engineInstanceId: 'new-process', endpoint: 'ws://127.0.0.1:24333/extension' };
    expect(selectLaunchTarget(target, [restarted])).toEqual(restarted);
    expect(() => selectLaunchTarget(target, [restarted, { ...restarted, engineInstanceId: 'another-process' }])).toThrow('多个');
    expect(selectLaunchTarget(target, [memfit, restarted])).toEqual(memfit);
  });
  it('never turns a malformed or remote stored target into unrestricted discovery', () => {
    expect(normalizeLaunchTarget(undefined)).toBeUndefined();
    expect(normalizeLaunchTarget({ ...target, endpoint: 'ws://example.com/extension' })).toEqual({ mode: 'none' });
    expect(normalizeLaunchTarget({ mode: 'engine' })).toEqual({ mode: 'none' });
    expect(normalizeLaunchTarget(target)).toEqual(target);
  });
});
