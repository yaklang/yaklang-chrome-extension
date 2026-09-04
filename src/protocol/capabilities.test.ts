import { describe, expect, it } from 'vitest';
import {
  BRIDGE_CAPABILITIES,
  canonicalCapabilityCatalogPayload,
  capabilityBaseScope,
  capabilityVisibleToAgent,
  getBridgeCapabilityCatalog,
} from './capabilities';

describe('versioned Bridge capability catalog', () => {
  it('derives every advertised method from one schema-backed catalog', async () => {
    const catalog = await getBridgeCapabilityCatalog();
    expect(catalog.version).toBe(1);
    expect(catalog.schemaDialect).toBe('http://json-schema.org/draft-07/schema#');
    expect(catalog.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(catalog.capabilities.map((capability) => capability.method)).toEqual(BRIDGE_CAPABILITIES);
    expect(new Set(catalog.capabilities.map((capability) => capability.method)).size).toBe(BRIDGE_CAPABILITIES.length);
    expect(new TextEncoder().encode(JSON.stringify(catalog)).byteLength).toBeLessThan(1024 * 1024);
  });

  it('publishes the real validation constraints and target semantics', async () => {
    const catalog = await getBridgeCapabilityCatalog();
    const evalCapability = catalog.capabilities.find((capability) => capability.method === 'browser.eval');
    expect(evalCapability).toMatchObject({
      domain: 'page',
      access: 'dangerous',
      scopes: ['browser.page.eval.expression'],
      targetMode: 'document',
      defaultTimeoutMs: 60_000,
    });
    expect(evalCapability?.conditionalScopes).toContainEqual({
      scope: 'browser.page.eval.program',
      when: 'mode=program',
    });
    expect(JSON.stringify(evalCapability?.paramsSchema)).toContain('"mode"');
    expect(JSON.stringify(evalCapability?.paramsSchema)).toContain('"program"');
    expect(capabilityBaseScope('browser.profile.validate')).toBe('browser.transform.execute');
    expect(catalog.capabilities.find((capability) => capability.method === 'browser.thumbnail')).toMatchObject({
      agentVisible: false,
    });
    expect(catalog.capabilities.find((capability) => capability.method === 'browser.handoff.presentation.get')).toMatchObject({
      agentVisible: false,
    });
    expect(catalog.capabilities.find((capability) => capability.method === 'browser.handoff.focus')).toMatchObject({
      agentVisible: false,
    });
    expect(catalog.capabilities.find((capability) => capability.method === 'browser.handoff.resolve')).toMatchObject({
      agentVisible: false,
    });
    expect(capabilityVisibleToAgent('browser.handoff.presentation.get')).toBe(false);
    expect(capabilityVisibleToAgent('browser.handoff.focus')).toBe(false);
    expect(capabilityVisibleToAgent('browser.handoff.resolve')).toBe(false);
    expect(capabilityVisibleToAgent('browser.thumbnail')).toBe(false);
    expect(capabilityVisibleToAgent('browser.context')).toBe(true);
    expect(catalog.capabilities.find((capability) => capability.method === 'browser.transform.recovery.capture')).toMatchObject({
      access: 'dangerous',
      scopes: ['browser.transform.manage', 'browser.debugger.control', 'browser.callable.execute'],
      targetMode: 'profile',
    });
    expect(capabilityBaseScope('browser.transform.recovery.validate')).toBe('browser.transform.execute');
    expect(catalog.capabilities.find((capability) => capability.method === 'browser.isolation.proof')).toMatchObject({
      domain: 'isolation',
      access: 'sensitive-read',
      scopes: ['browser.isolation.read', 'browser.cookies.read', 'browser.storage.read'],
      targetMode: 'none',
    });
    expect(catalog.capabilities.find((capability) => capability.method === 'browser.isolation.incognito.open')).toMatchObject({
      domain: 'isolation',
      access: 'dangerous',
      scopes: ['browser.isolation.manage'],
    });
    expect(catalog.capabilities.find((capability) => capability.method === 'browser.isolation.container.open')).toBeUndefined();
    expect(capabilityBaseScope('missing.capability')).toBeUndefined();
  });

  it('keeps canonical payloads stable and excludes the transmitted hash', async () => {
    const catalog = await getBridgeCapabilityCatalog();
    const payload = canonicalCapabilityCatalogPayload({
      version: catalog.version,
      schemaDialect: catalog.schemaDialect,
      capabilities: catalog.capabilities,
    });
    expect(payload).not.toContain(catalog.hash);
    expect(payload).toBe(canonicalCapabilityCatalogPayload({
      capabilities: catalog.capabilities,
      schemaDialect: catalog.schemaDialect,
      version: catalog.version,
    }));
  });

  it('matches the Go canonical JSON and SHA-256 test vector', async () => {
    const payload = canonicalCapabilityCatalogPayload({
      version: 1,
      schemaDialect: 'http://json-schema.org/draft-07/schema#',
      capabilities: [{
        method: 'browser.tabs',
        domain: 'page',
        access: 'read',
        summary: 'List tabs',
        scopes: ['browser.tabs.read'],
        targetMode: 'none',
        defaultTimeoutMs: 20_000,
        paramsSchema: { type: 'object', properties: {}, additionalProperties: false },
      }],
    });
    expect(payload).toBe(
      '{"capabilities":[{"access":"read","defaultTimeoutMs":20000,"domain":"page","method":"browser.tabs","paramsSchema":{"additionalProperties":false,"properties":{},"type":"object"},"scopes":["browser.tabs.read"],"summary":"List tabs","targetMode":"none"}],"schemaDialect":"http://json-schema.org/draft-07/schema#","version":1}',
    );
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    const hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    expect(hash).toBe('82bc1210338e773137b95359ca0b39c0443bae3d9fdae33f97942cf82119006f');
  });
});
