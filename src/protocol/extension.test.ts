import { describe, expect, it } from 'vitest';
import { parseExtensionRequest } from './extension';

describe('extension request schemas', () => {
  it('rejects unknown fields', () => {
    expect(() => parseExtensionRequest({ action: 'panel.update', payload: { enabled: true, unexpected: true } })).toThrow('unexpected');
  });

  it('accepts split panel policy and explicit Eval mode', () => {
    expect(parseExtensionRequest({
      action: 'panel.update',
      payload: { displayMode: 'active-task', siteMode: 'denylist', siteOrigins: ['https://example.test'] },
    }).action).toBe('panel.update');
    expect(parseExtensionRequest({
      action: 'context.eval', payload: { mode: 'program', code: '1 + 1', timeoutMs: 500 },
    }).action).toBe('context.eval');
  });

  it('accepts all browser transform grant scopes', () => {
    expect(parseExtensionRequest({
      action: 'grant.create',
      payload: {
        targets: [{ tabId: 12, frameId: 0 }],
        scopes: ['browser.transform.read', 'browser.transform.manage', 'browser.transform.execute'],
        durationMinutes: 5,
      },
    }).action).toBe('grant.create');
    expect(() => parseExtensionRequest({
      action: 'grant.create',
      payload: { targets: [{ tabId: 12, frameId: 0 }], scopes: ['browser.transform.unknown'], durationMinutes: 5 },
    })).toThrow('scopes');
  });

  it('validates the atomic current-site route reset action', () => {
    expect(parseExtensionRequest({
      action: 'proxy.site.route.clear', payload: { url: 'https://api.example.test/path' },
    }).action).toBe('proxy.site.route.clear');
    expect(() => parseExtensionRequest({
      action: 'proxy.site.route.clear', payload: { url: 'chrome://extensions' },
    })).toThrow('HTTP(S)');
  });

  it('validates recording bounds and recorded page callables', () => {
    expect(parseExtensionRequest({
      action: 'recording.start',
      payload: { tabId: 12, frameId: 0, captureValues: false, maxEntries: 500, maxValueBytes: 8_192 },
    }).action).toBe('recording.start');
    expect(() => parseExtensionRequest({
      action: 'recording.start', payload: { tabId: 12, maxEntries: 501 },
    })).toThrow();
    expect(parseExtensionRequest({
      action: 'callable.create',
      payload: {
        tabId: 12,
        frameId: 0,
        source: 'recording',
        callHandleId: 'handle-1',
        name: 'Login encrypt',
      },
    }).action).toBe('callable.create');
    expect(() => parseExtensionRequest({
      action: 'callable.create',
      payload: {
        tabId: 12,
        source: 'deep-capture',
        strategy: 'request-transaction',
        callFrameId: 'frame-1',
        transaction: {
          request: { method: 'POST', url: '/login', expectedDestinations: [] },
          inputMode: 'auto',
          boundaries: ['fetch'],
        },
      },
    })).toThrow('expectedDestinations');
    expect(parseExtensionRequest({
      action: 'callable.create',
      payload: {
        tabId: 12,
        source: 'deep-capture',
        strategy: 'request-transaction',
        callFrameId: 'frame-1',
        name: 'Login request transaction',
        transaction: {
          request: {
            method: 'POST',
            url: 'encrypt/aesrsa.php',
            expectedDestinations: ['body.encryptedData', 'body.encryptedKey', 'body.encryptedIv'],
          },
          inputMode: 'auto',
          boundaries: ['fetch', 'xhr', 'beacon', 'form'],
        },
      },
    }).action).toBe('callable.create');
    expect(() => parseExtensionRequest({
      action: 'callable.create',
      payload: {
        tabId: 12,
        source: 'recording',
        callHandleId: 'handle-1',
        name: '',
      },
    })).toThrow();
    expect(parseExtensionRequest({
      action: 'callable.execute', payload: { tabId: 12, callableId: 'callable-1', args: ['new plaintext'] },
    }).action).toBe('callable.execute');
  });

  it('validates deep capture matchers and bounded business callables', () => {
    expect(parseExtensionRequest({
      action: 'deep.capture.start',
      payload: {
        tabId: 12,
        frameId: 0,
        matcher: {
          kind: 'crypto',
          adapterId: 'webcrypto',
          operation: 'encrypt',
          wrapperHandleId: 'wrapper-1',
          frameHints: [{
            functionName: 'buildEnvelope', url: 'https://example.test/app.js', support: 3, averageDepth: 1,
          }],
        },
      },
    }).action).toBe('deep.capture.start');
    expect(() => parseExtensionRequest({
      action: 'deep.capture.start',
      payload: { tabId: 12, matcher: { kind: 'crypto', operation: 'crypto.subtle.encrypt' } },
    })).toThrow();
    expect(parseExtensionRequest({
      action: 'deep.capture.start',
      payload: { tabId: 12, matcher: { kind: 'request', urlPattern: '/api/login' } },
    }).action).toBe('deep.capture.start');
    expect(parseExtensionRequest({
      action: 'deep.capture.start',
      payload: {
        tabId: 12,
        matcher: {
          kind: 'boundary', eventKind: 'worker', operation: 'worker.postMessage', wrapperHandleId: 'boundary-wrapper-1',
        },
      },
    }).action).toBe('deep.capture.start');
    expect(() => parseExtensionRequest({
      action: 'deep.capture.start',
      payload: {
        tabId: 12,
        matcher: { kind: 'boundary', eventKind: 'fetch', operation: 'request', wrapperHandleId: 'boundary-wrapper-1' },
      },
    })).toThrow();
    expect(() => parseExtensionRequest({
      action: 'deep.capture.start', payload: { tabId: 12, matcher: { kind: 'request', urlPattern: '' } },
    })).toThrow();
    expect(parseExtensionRequest({
      action: 'callable.create',
      payload: {
        tabId: 12,
        source: 'deep-capture',
        strategy: 'selected-frame',
        callFrameId: 'frame-1',
        name: 'Login envelope',
      },
    }).action).toBe('callable.create');
    expect(parseExtensionRequest({
      action: 'callable.create',
      payload: {
        tabId: 12,
        source: 'deep-capture',
        strategy: 'expression',
        callFrameId: 'frame-1',
        name: 'Anonymous envelope',
        functionExpression: 'scopeFunction',
      },
    }).action).toBe('callable.create');
    expect(() => parseExtensionRequest({
      action: 'callable.create',
      payload: {
        tabId: 12,
        source: 'deep-capture',
        callFrameId: 'frame-1',
        name: 'Legacy expression',
        functionExpression: 'buildLoginEnvelope',
        sourceUrl: 'https://example.test/login.js',
        lineNumber: 42,
      },
    })).toThrow();
    expect(() => parseExtensionRequest({
      action: 'callable.execute', payload: { tabId: 12, callableId: 'callable-1', args: Array.from({ length: 65 }) },
    })).toThrow();
  });

  it('validates browser transform profiles and packet execution', () => {
    const profile = {
      name: 'Login gateway', enabled: true,
      target: { tabId: 12, frameId: 0, documentId: 'document-1' },
      origin: 'https://example.test',
      match: { methods: ['POST'], urlPattern: '*/api/login' },
      request: {
        enabled: true,
        nodes: [
          { id: 'input-1', name: 'Password', kind: 'context.read', path: 'body.password' },
          { id: 'call-1', name: 'Encrypt', kind: 'page.call', callableId: 'callable-1', arguments: [{ nodeId: 'input-1' }] },
          { id: 'output-1', name: 'Write', kind: 'output.write', source: { nodeId: 'call-1' }, destination: 'body.password', encoding: 'auto' },
        ],
      },
      response: { enabled: false, nodes: [] },
      failMode: 'closed' as const,
      maxConcurrency: 1,
    };
    expect(parseExtensionRequest({ action: 'transform.profile.save', payload: profile }).action).toBe('transform.profile.save');
    expect(parseExtensionRequest({
      action: 'transform.execute',
      payload: {
        profileId: 'profile-1', direction: 'request',
        packet: { method: 'POST', url: 'https://example.test/api/login', headers: [], bodyBase64: 'e30=' },
      },
    }).action).toBe('transform.execute');
    expect(() => parseExtensionRequest({
      action: 'transform.profile.save',
      payload: { ...profile, origin: 'https://example.test/login' },
    })).toThrow('来源');
    expect(() => parseExtensionRequest({
      action: 'transform.profile.save',
      payload: { ...profile, request: { ...profile.request, nodes: profile.request.nodes.filter((node) => node.kind !== 'output.write') } },
    })).toThrow('输出节点');
    expect(() => parseExtensionRequest({
      action: 'transform.profile.save',
      payload: {
        ...profile,
        request: { ...profile.request, nodes: profile.request.nodes.map((node) => node.kind === 'output.write' ? { ...node, destination: 'cookie.password' } : node) },
      },
    })).toThrow('输出目标');
    expect(() => parseExtensionRequest({
      action: 'transform.profile.save',
      payload: {
        ...profile,
        request: {
          ...profile.request,
          nodes: [...profile.request.nodes, { ...profile.request.nodes[0] }],
        },
      },
    })).toThrow('重复');
  });
});
