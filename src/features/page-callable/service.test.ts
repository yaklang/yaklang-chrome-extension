import { describe, expect, it } from 'vitest';
import type { BrowserPageCallable } from '@/types/models';
import { normalizeCallable } from './service';

const target = { tabId: 7, frameId: 0, documentId: 'document-1' };
const callable: Omit<BrowserPageCallable, 'target'> = {
  id: 'transaction-1',
  name: '登录请求业务封装',
  kind: 'request-transaction',
  operation: 'buildLoginEnvelope',
  origin: 'https://example.test',
  lifecycle: 'document',
  execution: { resultMode: 'auto', timeoutMs: 10_000 },
  inputSlots: [{ id: 'body', name: 'body', index: 0, role: 'data', dataType: 'object', required: true, retained: false }],
  output: {
    dataType: 'object', encoding: 'json', shape: 'envelope',
    paths: ['body.encryptedData', 'body.encryptedKey'],
  },
  transaction: {
    version: 2,
    prerequisites: [],
    request: {
      boundary: 'fetch',
      method: 'POST', url: 'https://example.test/login',
      expectedDestinations: ['body.encryptedData', 'body.encryptedKey'],
      bodyFormat: 'json',
    },
    inputMode: 'auto',
  },
  provenance: { eventId: 'request-1' },
  createdAt: 1,
};

describe('page callable metadata contract', () => {
  it('accepts an explicit asynchronous multi-output envelope', () => {
    expect(normalizeCallable(callable, target)).toMatchObject({
      target,
      execution: { resultMode: 'auto', timeoutMs: 10_000 },
      output: { shape: 'envelope', paths: ['body.encryptedData', 'body.encryptedKey'] },
    });
  });

  it('rejects a transaction whose declared envelope differs from its request boundary', () => {
    expect(normalizeCallable({
      ...callable,
      output: { ...callable.output, paths: ['body.encryptedData'] },
    }, target)).toBeUndefined();
  });

  it('rejects missing execution policy instead of silently selecting legacy behavior', () => {
    const { execution: _execution, ...legacy } = callable;
    expect(normalizeCallable(legacy, target)).toBeUndefined();
  });

  it('rejects the legacy client-authored single-request transaction contract', () => {
    expect(normalizeCallable({
      ...callable,
      transaction: {
        request: {
          method: 'POST', url: 'https://example.test/login',
          expectedDestinations: ['body.encryptedData', 'body.encryptedKey'],
          bodyFormat: 'json',
        },
        inputMode: 'auto',
        boundaries: ['fetch'],
      },
    }, target)).toBeUndefined();
  });
});
