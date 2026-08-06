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
    expect(parseExtensionRequest({ action: 'grant.refresh' }).action).toBe('grant.refresh');
    expect(() => parseExtensionRequest({
      action: 'grant.refresh',
      payload: { tabId: 12 },
    })).toThrow();
  });

  it('validates internal isolation actions and target-bound Cookie operations', () => {
    expect(parseExtensionRequest({
      action: 'isolation.inspect',
      payload: { tabIds: [12, 13] },
    }).action).toBe('isolation.inspect');
    expect(parseExtensionRequest({
      action: 'isolation.proof.create',
      payload: { leftTabId: 12, rightTabId: 13 },
    }).action).toBe('isolation.proof.create');
    expect(parseExtensionRequest({
      action: 'isolation.incognito.open',
      payload: { url: 'https://example.test/login' },
    }).action).toBe('isolation.incognito.open');
    expect(parseExtensionRequest({
      action: 'isolation.container.open',
      payload: { url: 'https://example.test/login', name: 'Yakit 身份 B' },
    }).action).toBe('isolation.container.open');
    expect(parseExtensionRequest({
      action: 'isolation.container.list',
    }).action).toBe('isolation.container.list');
    expect(parseExtensionRequest({
      action: 'isolation.container.remove',
      payload: { cookieStoreId: 'firefox-container-7' },
    }).action).toBe('isolation.container.remove');
    expect(() => parseExtensionRequest({
      action: 'isolation.container.remove',
      payload: { cookieStoreId: 'firefox-default' },
    })).toThrow();
    expect(parseExtensionRequest({
      action: 'cookie.list',
      payload: { url: 'https://example.test', tabId: 12 },
    }).action).toBe('cookie.list');
    expect(() => parseExtensionRequest({
      action: 'cookie.list',
      payload: { url: 'https://example.test' },
    })).toThrow('tabId');
    expect(() => parseExtensionRequest({
      action: 'isolation.inspect',
      payload: { tabIds: [] },
    })).toThrow();
  });

  it('validates browser authorization engine tasks and Yakit handoff', () => {
    expect(parseExtensionRequest({
      action: 'authorization.engine.task',
      payload: {
        schema: 'authorization.workspace.create',
        payload: {
          mode: 'horizontal',
          left: { tabId: 12, frameId: 0, accountLabel: 'A' },
          right: { tabId: 13, frameId: 0, accountLabel: 'B' },
        },
        timeoutMs: 60_000,
      },
    }).action).toBe('authorization.engine.task');
    expect(() => parseExtensionRequest({
      action: 'authorization.engine.task',
      payload: { schema: 'authorization.unknown', payload: {} },
    })).toThrow('schema');
    expect(parseExtensionRequest({
      action: 'authorization.yakit.open',
      payload: { workspaceId: 'authorization-workspace-1' },
    }).action).toBe('authorization.yakit.open');
    expect(parseExtensionRequest({
      action: 'network.capture.start',
      payload: {
        tabId: 12,
        frameId: 0,
        documentId: 'document-1',
        captureHeaders: true,
        captureBody: true,
      },
    }).action).toBe('network.capture.start');
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
        candidateId: '',
      },
    })).toThrow();
    expect(parseExtensionRequest({
      action: 'callable.create',
      payload: {
        tabId: 12,
        source: 'deep-capture',
        strategy: 'request-transaction',
        callFrameId: 'frame-1',
        name: 'Login request transaction',
        candidateId: 'candidate-aesrsa',
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
        candidateId: 'candidate-login',
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
    expect(() => parseExtensionRequest({
      action: 'transform.profile.save',
      payload: { ...profile, requestTransaction: {} },
    })).toThrow('requestTransaction');
    expect(parseExtensionRequest({
      action: 'analysis.profile.propose',
      payload: {
        tabId: 12,
        candidateId: 'candidate-1',
        callableId: 'callable-1',
        inputPaths: ['body'],
      },
    }).action).toBe('analysis.profile.propose');
    expect(parseExtensionRequest({
      action: 'analysis.profile.validate',
      payload: {
        tabId: 12,
        candidateId: 'candidate-1',
        callableId: 'callable-1',
        inputPaths: ['body'],
        packet: {
          method: 'POST',
          url: 'https://example.test/login',
          headers: [],
          bodyBase64: 'e30=',
        },
      },
    }).action).toBe('analysis.profile.validate');
    expect(parseExtensionRequest({
      action: 'analysis.profile.validation.latest',
      payload: { tabId: 12, frameId: 0 },
    }).action).toBe('analysis.profile.validation.latest');
    expect(parseExtensionRequest({
      action: 'transform.execute',
      payload: {
        profileId: 'profile-1', direction: 'request',
        packet: { method: 'POST', url: 'https://example.test/api/login', headers: [], bodyBase64: 'e30=' },
      },
    }).action).toBe('transform.execute');
    expect(parseExtensionRequest({
      action: 'transform.recovery.start',
      payload: { id: 'profile-1' },
    }).action).toBe('transform.recovery.start');
    expect(parseExtensionRequest({
      action: 'transform.recovery.capture',
      payload: {
        id: 'profile-1',
        tabId: 12,
        frameId: 0,
        documentId: 'document-2',
        callFrameId: 'frame-1',
        strategy: 'request-transaction',
      },
    }).action).toBe('transform.recovery.capture');
    expect(parseExtensionRequest({
      action: 'transform.recovery.validate',
      payload: {
        id: 'profile-1',
        packet: { method: 'POST', url: 'https://example.test/api/login', headers: [], bodyBase64: 'e30=' },
      },
    }).action).toBe('transform.recovery.validate');
    expect(parseExtensionRequest({
      action: 'transform.recovery.confirm',
      payload: { id: 'profile-1', validationId: 'validation-1' },
    }).action).toBe('transform.recovery.confirm');
    expect(() => parseExtensionRequest({
      action: 'transform.recovery.capture',
      payload: {
        id: 'profile-1',
        tabId: 12,
        frameId: 0,
        callFrameId: 'frame-1',
        strategy: 'expression',
      },
    })).toThrow();
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
