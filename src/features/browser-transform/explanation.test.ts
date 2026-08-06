import { describe, expect, it } from 'vitest';
import type {
  BrowserPageCallable,
  BrowserTransformProfile,
} from '@/types/models';
import { createBrowserTransformExplanation } from './explanation';

function callable(): BrowserPageCallable {
  return {
    id: 'callable-1',
    name: '页面登录封装',
    kind: 'request-transaction',
    operation: 'submitLogin',
    origin: 'https://example.test',
    target: { tabId: 7, frameId: 0, documentId: 'document-1' },
    lifecycle: 'document',
    execution: { resultMode: 'auto', timeoutMs: 10_000 },
    inputSlots: [{ id: 'body', name: 'body', index: 0, role: 'data', dataType: 'object', required: true, retained: false }],
    output: { dataType: 'object', encoding: 'json', shape: 'envelope', paths: ['body.password'] },
    transaction: {
      version: 2,
      prerequisites: [{
        boundary: 'fetch', method: 'GET', url: 'https://example.test/key?token=private',
        requestBodyFormat: 'none', maxRequestBodyBytes: 0,
        response: {
          statusCode: 200, url: 'https://example.test/key', bodyFormat: 'json', maxBodyBytes: 1_024,
          requiredPaths: ['body.key'],
        },
      }],
      request: {
        boundary: 'fetch', method: 'POST', url: 'https://example.test/login',
        expectedDestinations: ['body.password'], bodyFormat: 'json',
      },
      inputMode: 'auto',
    },
    provenance: {
      functionName: 'submitLogin',
      sourceUrl: 'https://example.test/app.js',
      lineNumber: 42,
      analysis: {
        version: 1,
        traceId: 'trace-1',
        confidence: { score: 95, level: 'high' },
        flow: ['明文', 'DES', 'Hex', 'body.password'],
        operations: [{
          operation: 'DES.encrypt', destination: 'body.password',
          crypto: {
            adapterId: 'cryptojs', providerKind: 'library', family: 'symmetric',
            operation: 'DES.encrypt', algorithm: 'DES.encrypt', mode: 'CBC', padding: 'Pkcs7',
          },
        }],
        evidence: [{ kind: 'exact-value', strength: 'proven', label: '输出指纹精确进入 body.password' }],
      },
    },
    createdAt: 1,
  };
}

function profile(pageCallable: BrowserPageCallable): BrowserTransformProfile {
  return {
    id: 'profile-1', name: '登录明文网关', enabled: true,
    target: pageCallable.target, isolationContextId: 'default', origin: pageCallable.origin,
    match: { methods: ['POST'], urlPattern: '*/login' },
    request: {
      enabled: true,
      nodes: [
        { id: 'input', name: '读取明文', kind: 'context.read', path: 'body' },
        { id: 'call', name: '页面登录封装', kind: 'page.call', callableId: pageCallable.id, arguments: [{ nodeId: 'input' }] },
        { id: 'output', name: '写入请求', kind: 'output.write', destination: 'body', source: { nodeId: 'call' }, encoding: 'json' },
      ],
    },
    response: { enabled: false, nodes: [] }, failMode: 'closed', maxConcurrency: 1,
    requestTransaction: { callableId: pageCallable.id, transaction: pageCallable.transaction! },
    createdAt: 1, updatedAt: 1,
  };
}

describe('browser transform explanation', () => {
  it('creates a bounded semantic flow without persisting URL query values', () => {
    const pageCallable = callable();
    const explanation = createBrowserTransformExplanation(profile(pageCallable), [pageCallable]);
    const stages = explanation.directions[0].stages;

    expect(stages.map((stage) => stage.kind)).toEqual([
      'input', 'prerequisite', 'page-call', 'output', 'session', 'transport',
    ]);
    expect(stages.find((stage) => stage.kind === 'page-call')).toMatchObject({
      owner: 'page', proof: 'observed',
      operations: [{ operation: 'DES.encrypt', destination: 'body.password', crypto: { mode: 'CBC', padding: 'Pkcs7' } }],
    });
    expect(stages.find((stage) => stage.kind === 'prerequisite')?.network).toMatchObject({
      method: 'GET', route: '/key?token', requiredPaths: ['body.key'],
    });
    expect(JSON.stringify(explanation)).not.toContain('private');
  });
});
