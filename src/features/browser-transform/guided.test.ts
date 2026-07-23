import { describe, expect, it } from 'vitest';
import type { BrowserPageCallable, BrowserTransformPacket } from '@/types/models';
import { executeTransformDirection } from './mapping';
import { compileGuidedTransform, defaultGuidedTransform, parseGuidedTransform } from './guided';

const callable: BrowserPageCallable = {
  id: 'encrypt-aes',
  name: '页面 AES-CBC 加密',
  kind: 'recorded-call',
  operation: 'AES.encrypt',
  algorithm: 'AES.encrypt',
  origin: 'https://example.test',
  target: { tabId: 1, frameId: 0, documentId: 'document-1' },
  lifecycle: 'document',
  execution: { resultMode: 'sync', timeoutMs: 8_000 },
  inputSlots: [{ id: 'data', name: 'data', index: 0, role: 'data', dataType: 'string', required: true, retained: false }],
  output: { dataType: 'CipherParams', encoding: 'auto', shape: 'value', paths: [] },
  provenance: { eventId: 'crypto-1' },
  createdAt: 1,
};

function bodyBase64(value: unknown): string {
  const valueText = typeof value === 'string' ? value : JSON.stringify(value);
  const bytes = new TextEncoder().encode(valueText);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBody(value: string): string {
  const binary = atob(value);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

describe('guided browser transform compiler', () => {
  it('maps a captured business closure to parameter-level body fields', async () => {
    const businessCallable: BrowserPageCallable = {
      ...callable,
      id: 'login-envelope',
      kind: 'business-closure',
      operation: 'buildLoginEnvelope',
      inputSlots: [
        { id: 'arg-0', name: 'password', index: 0, role: 'unknown', dataType: 'unknown', required: true, retained: false },
        { id: 'arg-1', name: 'account', index: 1, role: 'unknown', dataType: 'unknown', required: true, retained: false },
      ],
    };
    const guide = defaultGuidedTransform(businessCallable);
    expect(guide.inputPaths).toEqual(['body.password', 'body.account']);
    const direction = compileGuidedTransform(guide, businessCallable);
    let receivedArgs: unknown[] = [];
    await executeTransformDirection('profile-business', 'request', direction, {
      method: 'POST',
      url: 'https://example.test/login',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      bodyBase64: bodyBase64({ password: '123456', account: 'admin' }),
    }, async (callableId, args) => {
      receivedArgs = args;
      return { callableId, type: 'object', preview: 'Object', value: { ciphertext: 'value' }, durationMs: 1 };
    });
    expect(receivedArgs).toEqual(['123456', 'admin']);
  });

  it('passes the whole body to a single business parameter or unnamed fallback', () => {
    expect(defaultGuidedTransform({
      ...callable,
      kind: 'business-closure',
      inputSlots: [{ ...callable.inputSlots[0], name: 'payload' }],
    }).inputPaths).toEqual(['body']);
    expect(defaultGuidedTransform({
      ...callable,
      kind: 'business-closure',
      inputSlots: [
        { ...callable.inputSlots[0], name: 'arg0' },
        { ...callable.inputSlots[0], id: 'arg-1', name: 'options', index: 1 },
      ],
    }).inputPaths).toEqual(['body', 'body.options']);
  });

  it('compiles a form field and its content type without exposing DAG details', async () => {
    const guide = {
      ...defaultGuidedTransform(callable, { outputKind: 'form-field', outputField: 'encryptedData' }),
      setFormContentType: true,
    };
    const direction = compileGuidedTransform(guide, callable);
    const packet: BrowserTransformPacket = {
      method: 'POST',
      url: 'https://example.test/encrypt/aes.php',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      bodyBase64: bodyBase64({ username: 'admin', password: '123456' }),
    };
    const result = await executeTransformDirection('profile-1', 'request', direction, packet, async (callableId, args) => ({
      callableId,
      type: 'string',
      preview: 'cipher/value+',
      value: `cipher:${JSON.stringify(args[0])}`,
      durationMs: 1,
    }));

    expect(decodeBody(result.bodyBase64)).toBe(`encryptedData=${encodeURIComponent('cipher:{"username":"admin","password":"123456"}')}`);
    expect(result.setHeaders).toContainEqual({ name: 'Content-Type', value: 'application/x-www-form-urlencoded' });
    expect(parseGuidedTransform(direction, [callable])).toMatchObject({
      callableId: callable.id,
      inputPaths: ['body'],
      outputKind: 'form-field',
      outputField: 'encryptedData',
      setFormContentType: true,
    });
  });

  it.each([
    ['json-field', 'encryptedData', 'body.encryptedData'],
    ['header', 'X-Sign', 'header.X-Sign'],
    ['query', 'signature', 'query.signature'],
  ] as const)('compiles %s intent to an explicit output destination', (outputKind, outputField, destination) => {
    const direction = compileGuidedTransform({
      ...defaultGuidedTransform(callable), outputKind, outputField,
    }, callable);
    const output = direction.nodes.find((node) => node.kind === 'output.write');
    expect(output).toMatchObject({ destination });
    expect(parseGuidedTransform(direction, [callable])).toMatchObject({ outputKind, outputField });
  });
});
