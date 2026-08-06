import { describe, expect, it } from 'vitest';
import type {
  BrowserPageCallable,
  BrowserTransformProfile,
} from '@/types/models';
import { compileGuidedTransform, defaultGuidedTransform } from './guided';
import {
  BROWSER_TRANSFORM_RECOVERY_MAX_BYTES,
  compileBrowserTransformRecoveryDirections,
  createBrowserTransformRecoveryPlan,
  staleBrowserTransformProfile,
} from './recovery-plan';

function callable(
  id: string,
  output: BrowserPageCallable['output'] = {
    dataType: 'string',
    encoding: 'utf8',
    shape: 'value',
    paths: [],
  },
  transaction?: BrowserPageCallable['transaction'],
): BrowserPageCallable {
  return {
    id,
    name: '页面 AES 加密',
    kind: transaction ? 'request-transaction' : 'recorded-call',
    operation: 'CryptoJS.AES.encrypt',
    origin: 'http://127.0.0.1:82',
    target: { tabId: 9, frameId: 0, documentId: 'document-old' },
    lifecycle: 'document',
    execution: { resultMode: 'auto', timeoutMs: 8_000 },
    inputSlots: [{
      id: 'arg-0',
      name: 'payload',
      index: 0,
      role: 'data',
      dataType: 'string',
      required: true,
      retained: false,
    }],
    output,
    transaction,
    provenance: {
      sourceUrl: 'http://127.0.0.1:82/assets/app.random.js?access_token=source-secret#private',
      functionName: 'sendEncrypted',
      lineNumber: 42,
      businessFrameHints: [{
        functionName: 'sendEncrypted',
        url: 'http://127.0.0.1:82/assets/app.random.js?session=frame-secret',
        support: 1,
        averageDepth: 0,
      }],
    },
    createdAt: 1,
  };
}

function profile(primary: BrowserPageCallable): BrowserTransformProfile {
  return {
    id: 'profile-1',
    name: 'AES 明文网关',
    enabled: true,
    target: { ...primary.target },
    isolationContextId: 'browser-profile:store-1',
    cookieStoreId: 'store-1',
    origin: primary.origin,
    match: { methods: ['POST'], urlPattern: '*/encrypt/random.php' },
    request: compileGuidedTransform({
      ...defaultGuidedTransform(primary, { outputKind: 'form-field', outputField: 'ciphertext' }),
      outputKind: 'form-field',
      outputField: 'ciphertext',
      setFormContentType: true,
    }, primary),
    response: { enabled: false, nodes: [] },
    failMode: 'closed',
    maxConcurrency: 2,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('browser transform document recovery plan', () => {
  it('stores only capture semantics and disables a stale document binding', () => {
    const original = profile(callable('call-old'));
    const recovery = createBrowserTransformRecoveryPlan(original, [callable('call-old')], 10);

    expect(recovery).toMatchObject({
      contractVersion: 1,
      state: 'ready',
      desiredEnabled: true,
      capture: {
        kind: 'request',
        method: 'POST',
        url: 'http://127.0.0.1:82/encrypt/random.php',
        urlPattern: '/encrypt/random.php',
        bodyFormat: 'form',
        expectedDestinations: ['body.ciphertext'],
        automatic: true,
      },
      binding: {
        callableId: 'call-old',
        operation: 'CryptoJS.AES.encrypt',
      },
    });
    const serialized = JSON.stringify(recovery);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(BROWSER_TRANSFORM_RECOVERY_MAX_BYTES);
    expect(serialized).not.toContain('source-secret');
    expect(serialized).not.toContain('frame-secret');
    expect(serialized).not.toContain('access_token');
    expect(serialized).not.toContain('session=');

    const stale = staleBrowserTransformProfile({ ...original, recovery }, '页面已刷新', 20);
    expect(stale.enabled).toBe(false);
    expect(stale.recovery).toMatchObject({
      state: 'stale',
      desiredEnabled: true,
      reason: '页面已刷新',
    });
  });

  it('recompiles a value field gateway into one full request transaction without double wrapping', () => {
    const originalCallable = callable('call-old');
    const original = profile(originalCallable);
    const recovery = createBrowserTransformRecoveryPlan(original, [originalCallable], 10);
    expect(recovery).toBeDefined();

    const transaction = {
      version: 2 as const,
      prerequisites: [],
      request: {
        boundary: 'fetch' as const,
        method: 'POST',
        url: 'http://127.0.0.1:82/encrypt/random.php',
        expectedDestinations: ['body.ciphertext'],
        bodyFormat: 'form' as const,
      },
      inputMode: 'auto' as const,
    };
    const captured = callable('call-new', {
      dataType: 'object',
      encoding: 'utf8',
      shape: 'envelope',
      paths: ['body.ciphertext'],
    }, transaction);
    const directions = compileBrowserTransformRecoveryDirections(original, recovery!, captured);

    expect(directions.request.nodes.filter((node) => node.kind === 'page.call')).toHaveLength(1);
    expect(directions.request.nodes.find((node) => node.kind === 'page.call')).toMatchObject({
      callableId: 'call-new',
    });
    expect(directions.request.nodes.some((node) => node.kind === 'builtin' && node.operation === 'form.compose')).toBe(false);
    expect(directions.request.nodes.some((node) => node.kind === 'builtin' && node.operation === 'form.serialize')).toBe(true);
    expect(directions.request.nodes.find((node) => node.kind === 'output.write' && node.destination === 'body')).toMatchObject({
      encoding: 'text',
    });
  });

  it('fails closed when multiple page functions make automatic rebinding ambiguous', () => {
    const first = callable('call-a');
    const second = callable('call-b');
    const original = profile(first);
    original.request.nodes.splice(-1, 0, {
      id: 'second-call',
      name: '第二个页面调用',
      kind: 'page.call',
      callableId: second.id,
      arguments: [],
    });

    const recovery = createBrowserTransformRecoveryPlan(original, [first, second], 10);
    expect(recovery?.capture.automatic).toBe(false);
    expect(recovery?.capture.reason).toContain('多个页面函数');
  });

  it('does not persist a sensitive request query or arm an inexact recovery boundary', () => {
    const transaction = callable('call-sensitive', {
      dataType: 'object',
      encoding: 'utf8',
      shape: 'envelope',
      paths: ['body.ciphertext'],
    }, {
      version: 2,
      prerequisites: [],
      request: {
        boundary: 'fetch',
        method: 'POST',
        url: 'http://127.0.0.1:82/encrypt/random.php?access_token=request-secret',
        expectedDestinations: ['body.ciphertext'],
        bodyFormat: 'form',
      },
      inputMode: 'auto',
    });
    const recovery = createBrowserTransformRecoveryPlan(profile(transaction), [transaction], 10);
    const serialized = JSON.stringify(recovery);

    expect(recovery?.capture.automatic).toBe(false);
    expect(recovery?.capture.reason).toContain('精确路由');
    expect(recovery?.binding.transaction?.request.url).toBe('http://127.0.0.1:82/encrypt/random.php');
    expect(serialized).not.toContain('request-secret');
    expect(serialized).not.toContain('access_token');
  });
});
