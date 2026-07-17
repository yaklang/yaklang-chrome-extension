import { vi, describe, expect, it } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: { storage: {} } }));

import type { BridgeConfig } from '@/types/models';
import { applyPolicyToBridge, assertGrantPolicy } from './managed';

const bridge: BridgeConfig = {
  transport: 'websocket', endpoint: 'ws://127.0.0.1:64333/extension', nativeHost: 'default.host',
  autoConnect: false, installationId: 'install-1',
};

describe('managed policy enforcement', () => {
  it('forces Native Messaging without replacing the paired device identity', () => {
    expect(applyPolicyToBridge(bridge, { disableWebSocket: true, nativeHost: 'managed.host', autoConnect: true }))
      .toEqual({ ...bridge, transport: 'native', nativeHost: 'managed.host', autoConnect: true });
  });

  it('caps grants and rejects origins/program Eval', () => {
    expect(assertGrantPolicy({ maxGrantMinutes: 30 }, { durationMinutes: 120, origins: ['https://a.test'], programEval: false })).toBe(30);
    expect(() => assertGrantPolicy({ allowProgramEval: false }, { durationMinutes: 5, origins: [], programEval: true })).toThrow('禁止');
    expect(() => assertGrantPolicy({ grantAllowedOrigins: ['https://a.test'] }, { durationMinutes: 5, origins: ['https://b.test'], programEval: false })).toThrow('不允许');
  });
});
