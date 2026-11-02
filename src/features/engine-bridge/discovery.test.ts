import { describe, expect, it } from 'vitest';
import { bridgeDiscoveryEndpoints } from './discovery';

describe('Bridge discovery endpoints', () => {
  it('spreads the default candidates across independent Windows reservation ranges', () => {
    const endpoints = bridgeDiscoveryEndpoints('ws://127.0.0.1:64333/extension');
    expect(endpoints).toHaveLength(64);
    for (const port of [64333, 64348, 14333, 24333, 34333]) {
      expect(endpoints).toContain(`ws://127.0.0.1:${port}/discovery`);
    }
    expect(new Set(endpoints).size).toBe(endpoints.length);
  });

  it('tries a custom port before the defaults and bounds the port range', () => {
    const endpoints = bridgeDiscoveryEndpoints('ws://127.0.0.1:65535/extension');
    expect(endpoints[0]).toBe('ws://127.0.0.1:65535/discovery');
    expect(endpoints).toHaveLength(65);
  });

  it('includes IPv4 when localhost or IPv6 cannot reach a WSL listener', () => {
    for (const hostname of ['localhost', '[::1]']) {
      expect(bridgeDiscoveryEndpoints(`ws://${hostname}:64333/extension`))
        .toContain('ws://127.0.0.1:64333/discovery');
    }
  });
});
