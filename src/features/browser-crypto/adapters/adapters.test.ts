import { describe, expect, it } from 'vitest';
import type { CryptoAdapterScope, CryptoAdapterToolkit } from './contract';
import { cryptoAdapterLabel } from './catalog';
import { cryptoJsAdapter } from './cryptojs';
import { jsEncryptAdapter } from './jsencrypt';
import { webCryptoAdapter } from './webcrypto';
import { smCryptoAdapter } from './sm-crypto';
import { nodeForgeAdapter } from './node-forge';
import { jsrsasignAdapter } from './jsrsasign';
import { joseAdapter } from './jose';
import { libsodiumAdapter } from './libsodium';
import { tweetNaclAdapter } from './tweetnacl';
import { nobleAdapter } from './noble';
import { openPgpAdapter } from './openpgp';

function byteLength(value: unknown): number | undefined {
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (value && typeof value === 'object' && typeof (value as { sigBytes?: unknown }).sigBytes === 'number') {
    return (value as { sigBytes: number }).sigBytes;
  }
  return undefined;
}

function toolkit(): CryptoAdapterToolkit {
  return {
    unique: (prefix) => `${prefix}-1`,
    byteLength,
    dataType: (value) => typeof value,
    fingerprint: () => 'v2:opaque-fingerprint',
    argument: (index, role, value, replaceable, retained, summary) => ({
      index,
      role,
      dataType: typeof value,
      byteLength: byteLength(value),
      replaceable,
      retained,
      summary,
    }),
    collectEvidence: (value, path) => [{
      path,
      fingerprint: `fingerprint:${String(value)}`,
      encoding: 'text',
      byteLength: byteLength(String(value)) || 0,
    }],
    defaultOutputEvidence: () => [],
    defaultAdaptInput: (value) => value,
    bytesForInput: (value) => value instanceof Uint8Array ? value : undefined,
    bytesToBase64: (value) => `base64:${Array.from(value).join(',')}`,
  };
}

describe('page crypto adapters', () => {
  it('keeps the UI catalog separate and safely falls back for unknown adapter IDs', () => {
    expect(cryptoAdapterLabel('webcrypto')).toBe('WebCrypto');
    expect(cryptoAdapterLabel('libsodium')).toBe('libsodium.js');
    expect(cryptoAdapterLabel('openpgp')).toBe('OpenPGP.js');
    expect(cryptoAdapterLabel('vendor-suite.v2')).toBe('vendor-suite.v2');
  });

  it('describes WebCrypto input roles and state without reading key material', () => {
    const subtlePrototype = { encrypt() { return Promise.resolve(new ArrayBuffer(0)); } };
    const subtle = Object.create(subtlePrototype) as SubtleCrypto;
    const operations = webCryptoAdapter.discover({
      window: { crypto: { subtle } } as unknown as Window,
      crypto: { subtle } as Crypto,
    });
    const encrypt = operations.find((item) => item.operation === 'encrypt');
    const key = { type: 'secret' } as CryptoKey;
    const plan = encrypt?.describe(subtle, [
      { name: 'AES-GCM', iv: new Uint8Array(12), tagLength: 128 },
      key,
      new Uint8Array([1, 2, 3]),
    ], toolkit());

    expect(plan?.crypto).toMatchObject({
      adapterId: 'webcrypto',
      providerKind: 'native',
      family: 'symmetric',
      operation: 'encrypt',
      algorithm: 'AES-GCM tag=128 ivBytes=12',
      state: { model: 'receiver', phase: 'one-shot' },
    });
    expect(plan?.arguments.map((argument) => argument.role)).toEqual(['algorithm', 'key', 'data']);
    expect(plan?.arguments[2]).toMatchObject({ replaceable: true, retained: true, byteLength: 3 });
    expect(JSON.stringify(plan)).not.toContain('secret');
  });

  it('describes CryptoJS modes and adapts bytes through the page encoder', () => {
    const CBC = {};
    const Pkcs7 = {};
    const parsed: string[] = [];
    const cryptoJs = {
      AES: { encrypt() { return 'cipher'; } },
      mode: { CBC },
      pad: { Pkcs7 },
      enc: { Base64: { parse(value: string) { parsed.push(value); return { wordArray: value }; } } },
    };
    const scope = { window: { CryptoJS: cryptoJs } as unknown as Window } satisfies CryptoAdapterScope;
    const encrypt = cryptoJsAdapter.discover(scope).find((item) => item.operation === 'AES.encrypt');
    const plan = encrypt?.describe(cryptoJs.AES, [
      { sigBytes: 3 },
      { sigBytes: 16 },
      { mode: CBC, padding: Pkcs7, iv: { sigBytes: 16 } },
    ], toolkit());

    expect(plan?.crypto).toMatchObject({
      adapterId: 'cryptojs', family: 'symmetric', operation: 'AES.encrypt',
      mode: 'CBC', padding: 'Pkcs7', outputEncoding: 'base64',
    });
    expect(plan?.arguments[2].summary).toBe('mode=CBC padding=Pkcs7 ivBytes=16');
    expect(plan?.inputEvidence?.({}).map((item) => item.path)).toEqual([
      '$input',
      '$input.key',
      '$input.iv',
    ]);
    expect(plan?.adaptInput?.(new Uint8Array([4, 5, 6]))).toEqual({ wordArray: 'base64:4,5,6' });
    expect(parsed).toEqual(['base64:4,5,6']);
  });

  it('retains only bounded JSEncrypt receiver metadata', () => {
    const prototype = {
      encrypt() { return 'ciphertext'; },
      decrypt() { return 'plaintext'; },
      sign() { return 'signature'; },
      verify() { return true; },
    };
    const instance = {
      key: {
        n: { bitLength: () => 2048, toString: () => 'public-modulus' },
        e: 65_537,
      },
    };
    const encrypt = jsEncryptAdapter.discover({
      window: { JSEncrypt: { prototype } } as unknown as Window,
    }).find((item) => item.operation === 'encrypt');
    const plan = encrypt?.describe(instance, ['plain'], toolkit());

    expect(plan?.crypto).toMatchObject({
      adapterId: 'jsencrypt', family: 'asymmetric', algorithm: 'RSA',
      state: { model: 'receiver', phase: 'one-shot' },
      key: { kind: 'public', bits: 2048, fingerprint: 'v2:opaque-fingerprint' },
    });
    expect(plan?.arguments[0]).toMatchObject({ role: 'data', replaceable: true, retained: true });
    expect(JSON.stringify(plan?.crypto)).not.toContain('public-modulus');
  });

  it('describes sm-crypto SM2/SM3/SM4 using one bounded contract', () => {
    const smCrypto = {
      sm2: {
        doEncrypt: () => 'cipher',
        doDecrypt: () => 'plain',
        doSignature: () => 'signature',
        doVerifySignature: () => true,
      },
      sm3: () => 'digest',
      sm4: { encrypt: () => 'cipher', decrypt: () => 'plain' },
    };
    const operations = smCryptoAdapter.discover({ window: { ...smCrypto } as unknown as Window });
    const sm4 = operations.find((item) => item.operation === 'sm4.encrypt');
    const plan = sm4?.describe(smCrypto.sm4, [
      'plain',
      '00112233445566778899aabbccddeeff',
      { mode: 'cbc', padding: 'pkcs#7', iv: '0102030405060708' },
    ], toolkit());
    const verify = operations.find((item) => item.operation === 'sm2.verify')?.describe(
      smCrypto.sm2, ['plain', 'signature', 'public-key', { hash: true }], toolkit(),
    );

    expect(operations).toHaveLength(7);
    expect(plan?.crypto).toMatchObject({
      adapterId: 'sm-crypto', family: 'symmetric', algorithm: 'SM4', mode: 'cbc', padding: 'pkcs#7',
      state: { model: 'stateless', phase: 'one-shot' },
      key: { kind: 'secret', bits: 128, fingerprint: 'v2:opaque-fingerprint' },
    });
    expect(plan?.arguments[2].summary).toContain('ivBytes=16');
    expect(verify?.callableKind).toBe('verify');
    expect(verify?.arguments.map((item) => item.role)).toEqual(['data', 'signature', 'key', 'options']);
    expect(JSON.stringify(plan?.crypto)).not.toContain('00112233445566778899aabbccddeeff');
  });

  it('discovers node-forge stateful cipher sessions without treating them as replay-safe one-shot calls', () => {
    const outputBuffer = {
      bytes: () => 'cipher-bytes',
      length: () => 12,
      getBytes: () => 'cipher-bytes',
    };
    const session = {
      output: outputBuffer,
      start: () => undefined,
      update: () => undefined,
      finish: () => true,
    };
    const forge = {
      cipher: { createCipher: () => session, createDecipher: () => session },
      hmac: { create: () => ({ start() {}, update() {}, digest: () => outputBuffer }) },
      pki: {
        publicKeyFromPem: () => ({
          n: { bitLength: () => 2048, toString: () => 'modulus' }, e: 65_537,
          encrypt: (value: string) => value, verify: () => true,
        }),
        privateKeyFromPem: () => ({
          n: { bitLength: () => 2048, toString: () => 'modulus' }, e: 65_537,
          d: {}, decrypt: (value: string) => value, sign: () => 'signature',
        }),
      },
      md: {
        sha256: { create: () => ({ start() {}, update() {}, digest: () => outputBuffer }) },
      },
    };
    const operations = nodeForgeAdapter.discover({ window: { forge } as unknown as Window });
    const factory = operations.find((item) => item.operation === 'cipher.create.encrypt');
    const factoryPlan = factory?.describe(forge.cipher, ['AES-CBC', 'secret-key'], toolkit());
    const sessionOperations = factoryPlan?.discoverResult?.(session) || [];
    const update = sessionOperations.find((item) => item.operation === 'cipher.encrypt.update');
    const finish = sessionOperations.find((item) => item.operation === 'cipher.encrypt.finish');
    const updatePlan = update?.describe(session, [outputBuffer], toolkit());
    const finishPlan = finish?.describe(session, [], toolkit());

    expect(factoryPlan?.crypto).toMatchObject({
      adapterId: 'node-forge', family: 'symmetric', algorithm: 'AES-CBC',
      state: { model: 'session', phase: 'create', correlationId: 'forge-session-1' },
    });
    expect(updatePlan?.crypto.state).toMatchObject({ model: 'stream', phase: 'update', correlationId: 'forge-session-1' });
    expect(updatePlan?.callableKind).toBeUndefined();
    expect(finishPlan?.outputEvidence?.(true)[0]).toMatchObject({ path: '$receiver.output' });
    expect(sessionOperations.some((item) => item.operation === 'cipher.encrypt.output.getBytes')).toBe(true);
  });

  it('turns node-forge RSA key instances into receiver-bound direct operations without exporting PEM', () => {
    const key = {
      n: { bitLength: () => 2048, toString: () => 'private-modulus' },
      e: 65_537,
      encrypt: (value: string) => `cipher:${value}`,
      verify: () => true,
    };
    const forge = { pki: { publicKeyFromPem: () => key } };
    const factory = nodeForgeAdapter.discover({ window: { forge } as unknown as Window })
      .find((item) => item.operation === 'pki.public-key.create');
    const plan = factory?.describe(forge.pki, ['-----BEGIN PUBLIC KEY-----raw-material'], toolkit());
    const encrypt = plan?.discoverResult?.(key).find((item) => item.operation === 'rsa.encrypt');
    const encryptPlan = encrypt?.describe(key, ['plain', 'RSA-OAEP'], toolkit());

    expect(plan?.outputEvidence?.(key)).toEqual([]);
    expect(encryptPlan?.callableKind).toBe('encrypt');
    expect(encryptPlan?.crypto).toMatchObject({
      family: 'asymmetric', algorithm: 'RSA', state: { model: 'receiver', phase: 'one-shot' },
      key: { kind: 'public', bits: 2048, fingerprint: 'v2:opaque-fingerprint' },
    });
    expect(JSON.stringify(encryptPlan?.crypto)).not.toContain('raw-material');
    expect(JSON.stringify(encryptPlan?.crypto)).not.toContain('private-modulus');
  });

  it('models a jsrsasign constructor session as create, init, update, and final stages', () => {
    class Signature {
      constructor(public options: { alg: string }) {}
      init(_key: unknown) {}
      updateString(_value: string) {}
      sign() { return 'deadbeef'; }
      verify(_signature: string) { return true; }
    }
    const JWS = {
      sign: (_algorithm: string, _header: unknown, payload: unknown) => `jws:${String(payload)}`,
      verify: () => true,
      verifyJWT: () => true,
      getJWKthumbprint: () => 'thumbprint',
    };
    const window = {
      KJUR: { crypto: { Signature }, jws: { JWS } },
      KEYUTIL: { getKey: () => ({}), getJWK: () => ({ kty: 'RSA' }), getPEM: () => 'pem' },
    } as unknown as Window;
    const operations = jsrsasignAdapter.discover({ window });
    const constructor = operations.find((item) => item.operation === 'Signature.create');
    const createPlan = constructor?.describe(undefined, [{ alg: 'SHA256withRSA' }], toolkit());
    const instance = new Signature({ alg: 'SHA256withRSA' });
    const stages = createPlan?.discoverResult?.(instance) || [];
    const init = stages.find((item) => item.operation === 'Signature.init')
      ?.describe(instance, ['-----BEGIN PRIVATE KEY-----private-material'], toolkit());
    const update = stages.find((item) => item.operation === 'Signature.updateString')
      ?.describe(instance, ['canonical-request'], toolkit());
    const sign = stages.find((item) => item.operation === 'Signature.sign')
      ?.describe(instance, [], toolkit());

    expect(constructor?.invocationMode).toBe('construct');
    expect(createPlan?.crypto).toMatchObject({
      adapterId: 'jsrsasign', family: 'signature', algorithm: 'SHA256withRSA',
      state: { model: 'session', phase: 'create', correlationId: 'jsrsasign-signature-1' },
    });
    expect(init?.crypto.state).toMatchObject({ phase: 'init', correlationId: 'jsrsasign-signature-1' });
    expect(update?.crypto.state).toMatchObject({ phase: 'update', correlationId: 'jsrsasign-signature-1' });
    expect(sign?.crypto.state).toMatchObject({ phase: 'final', correlationId: 'jsrsasign-signature-1' });
    expect(sign?.callableKind).toBeUndefined();
    expect(JSON.stringify(init?.crypto)).not.toContain('private-material');

    const jwsSign = operations.find((item) => item.operation === 'JWS.sign')
      ?.describe(JWS, ['RS256', { alg: 'RS256' }, { account: 'admin' }, 'private-key'], toolkit());
    expect(jwsSign).toMatchObject({ inputIndex: 2, callableKind: 'sign' });
  });

  it('models jose builders as async stateful envelopes and keeps key material opaque', () => {
    class SignJWT {
      constructor(public payload: unknown) {}
      setProtectedHeader(_header: unknown) { return this; }
      setIssuedAt() { return this; }
      sign(_key: unknown) { return Promise.resolve('header.payload.signature'); }
    }
    class CompactSign {
      constructor(public payload: Uint8Array) {}
      setProtectedHeader(_header: unknown) { return this; }
      sign(_key: unknown) { return Promise.resolve('header.payload.signature'); }
    }
    class CompactEncrypt {
      constructor(public payload: Uint8Array) {}
      setProtectedHeader(_header: unknown) { return this; }
      encrypt(_key: unknown) { return Promise.resolve('compact-jwe'); }
    }
    const jose = {
      SignJWT, CompactSign, CompactEncrypt,
      compactVerify: async () => ({ payload: new Uint8Array() }),
      jwtVerify: async () => ({ payload: {} }),
      compactDecrypt: async () => ({ plaintext: new Uint8Array() }),
      jwtDecrypt: async () => ({ payload: {} }),
      importJWK: async () => ({}),
      exportJWK: async () => ({ kty: 'RSA' }),
    };
    const operations = joseAdapter.discover({ window: { jose } as unknown as Window });
    const constructor = operations.find((item) => item.operation === 'SignJWT.create');
    const createPlan = constructor?.describe(undefined, [{ account: 'admin' }], toolkit());
    const instance = new SignJWT({ account: 'admin' });
    const stages = createPlan?.discoverResult?.(instance) || [];
    const header = stages.find((item) => item.operation === 'SignJWT.setProtectedHeader')
      ?.describe(instance, [{ alg: 'RS256' }], toolkit());
    const final = stages.find((item) => item.operation === 'SignJWT.sign')
      ?.describe(instance, [{ type: 'private', algorithm: { name: 'RSA-PSS' }, secret: 'never-export' }], toolkit());

    expect(constructor?.invocationMode).toBe('construct');
    expect(createPlan?.crypto.state).toMatchObject({ model: 'async-ready', phase: 'create', correlationId: 'jose-session-1' });
    expect(header?.crypto).toMatchObject({ algorithm: 'RS256', state: { phase: 'update', correlationId: 'jose-session-1' } });
    expect(final?.crypto).toMatchObject({
      family: 'signature', algorithm: 'RS256', key: { kind: 'private' },
      state: { phase: 'final', correlationId: 'jose-session-1' },
    });
    expect(stages.find((item) => item.operation === 'SignJWT.sign')?.resultMode).toBe('promise');
    expect(final?.callableKind).toBeUndefined();
    expect(JSON.stringify(final?.crypto)).not.toContain('never-export');
    expect(operations.find((item) => item.operation === 'CompactVerify.verify')?.resultMode).toBe('promise');
  });

  it('describes libsodium async-ready one-shot operations and preserves the real AEAD input index', () => {
    const sodium = {
      ready: Promise.resolve(),
      crypto_secretbox_easy: () => new Uint8Array([1]),
      crypto_secretbox_open_easy: () => new Uint8Array([2]),
      crypto_aead_xchacha20poly1305_ietf_encrypt: () => new Uint8Array([3]),
      crypto_aead_xchacha20poly1305_ietf_decrypt: () => new Uint8Array([4]),
      crypto_sign_detached: () => new Uint8Array([5]),
      crypto_sign_verify_detached: () => true,
    };
    const operations = libsodiumAdapter.discover({ window: { sodium } as unknown as Window });
    const secretbox = operations.find((item) => item.operation === 'secretbox.encrypt')?.describe(
      sodium,
      [new Uint8Array([1, 2]), new Uint8Array(24), new Uint8Array(32).fill(9)],
      toolkit(),
    );
    const xchachaDecrypt = operations.find((item) => item.operation === 'aead.xchacha20poly1305.decrypt')?.describe(
      sodium,
      [null, new Uint8Array([8, 9]), new Uint8Array([1]), new Uint8Array(24), new Uint8Array(32).fill(7)],
      toolkit(),
    );

    expect(secretbox?.crypto).toMatchObject({
      adapterId: 'libsodium', family: 'symmetric', algorithm: 'XSalsa20-Poly1305',
      state: { model: 'async-ready', phase: 'one-shot' },
      key: { kind: 'secret', bits: 256, fingerprint: 'v2:opaque-fingerprint' },
    });
    expect(secretbox?.arguments.map((item) => item.role)).toEqual(['data', 'nonce', 'key']);
    expect(xchachaDecrypt).toMatchObject({ inputIndex: 1, callableKind: 'decrypt' });
    expect(xchachaDecrypt?.arguments.map((item) => item.role)).toEqual(['options', 'data', 'aad', 'nonce', 'key']);
    expect(JSON.stringify(secretbox?.crypto)).not.toContain('9,9,9');
  });

  it('discovers TweetNaCl nested methods without flattening nonce or key semantics', () => {
    const secretbox = Object.assign(
      (_message: Uint8Array, _nonce: Uint8Array, _key: Uint8Array) => new Uint8Array([1]),
      { open: () => new Uint8Array([2]) },
    );
    const detached = Object.assign(
      (_message: Uint8Array, _key: Uint8Array) => new Uint8Array([3]),
      { verify: () => true },
    );
    const sign = Object.assign(
      (_message: Uint8Array, _key: Uint8Array) => new Uint8Array([4]),
      { open: () => new Uint8Array([5]), detached },
    );
    const nacl = { secretbox, sign, hash: () => new Uint8Array(64) };
    const operations = tweetNaclAdapter.discover({ window: { nacl } as unknown as Window });
    const open = operations.find((item) => item.operation === 'secretbox.decrypt')?.describe(
      secretbox,
      [new Uint8Array([1]), new Uint8Array(24), new Uint8Array(32)],
      toolkit(),
    );
    const verify = operations.find((item) => item.operation === 'ed25519.verify')?.describe(
      detached,
      [new Uint8Array([1]), new Uint8Array(64), new Uint8Array(32)],
      toolkit(),
    );

    expect(open?.crypto).toMatchObject({ adapterId: 'tweetnacl', algorithm: 'XSalsa20-Poly1305' });
    expect(open?.arguments[1]).toMatchObject({ role: 'nonce', summary: 'nonceBytes=24' });
    expect(verify).toMatchObject({ inputIndex: 0, callableKind: 'verify' });
    expect(verify?.arguments.map((item) => item.role)).toEqual(['data', 'signature', 'key']);
  });

  it('promotes explicit noble cipher factories to receiver-bound encrypt/decrypt callables', () => {
    const cipher = {
      encrypt: (value: Uint8Array) => value,
      decrypt: (value: Uint8Array) => value,
    };
    const nobleCiphers = { gcm: () => cipher };
    const nobleCurves = { ed25519: { sign: () => new Uint8Array(64), verify: () => true } };
    const operations = nobleAdapter.discover({
      window: { nobleCiphers, nobleCurves } as unknown as Window,
    });
    const factory = operations.find((item) => item.operation === 'AES-GCM.create');
    const create = factory?.describe(
      nobleCiphers,
      [new Uint8Array(32), new Uint8Array(12), new Uint8Array([1, 2])],
      toolkit(),
    );
    const encrypt = create?.discoverResult?.(cipher).find((item) => item.operation === 'AES-GCM.encrypt');
    const encryptPlan = encrypt?.describe(cipher, [new Uint8Array([3, 4])], toolkit());
    const verify = operations.find((item) => item.operation === 'ed25519.verify')?.describe(
      nobleCurves.ed25519,
      [new Uint8Array(64), new Uint8Array([5]), new Uint8Array(32)],
      toolkit(),
    );

    expect(create?.crypto).toMatchObject({
      adapterId: 'noble', algorithm: 'AES-GCM', mode: 'gcm',
      state: { model: 'session', phase: 'create', correlationId: 'noble-cipher-1' },
    });
    expect(encryptPlan).toMatchObject({
      inputIndex: 0, callableKind: 'encrypt',
      crypto: { state: { model: 'receiver', correlationId: 'noble-cipher-1' } },
    });
    expect(verify).toMatchObject({ inputIndex: 1, callableKind: 'verify' });
  });

  it('uses OpenPGP message state as evidence while requiring a business closure for safe replay', () => {
    const openpgp = {
      createMessage: async () => ({}),
      readMessage: async () => ({}),
      encrypt: async () => 'armored',
      decrypt: async () => ({ data: 'plain' }),
      sign: async () => 'signature',
      verify: async () => ({ signatures: [] }),
    };
    const operations = openPgpAdapter.discover({ window: { openpgp } as unknown as Window });
    const message = {};
    const create = operations.find((item) => item.operation === 'createMessage')?.describe(
      openpgp,
      [{ text: 'plain request' }],
      toolkit(),
    );
    create?.discoverResult?.(message);
    const encrypt = operations.find((item) => item.operation === 'OpenPGP.encrypt')?.describe(
      openpgp,
      [{ message, encryptionKeys: [{}], format: 'armored' }],
      toolkit(),
    );
    const decrypt = operations.find((item) => item.operation === 'OpenPGP.decrypt')?.describe(
      openpgp,
      [{ message, decryptionKeys: [{}] }],
      toolkit(),
    );

    expect(encrypt?.crypto).toMatchObject({
      adapterId: 'openpgp', family: 'asymmetric', algorithm: 'OpenPGP public-key',
      state: { model: 'async-ready', phase: 'final', correlationId: 'openpgp-message-1' },
      key: { kind: 'public' },
    });
    expect(encrypt?.callableKind).toBeUndefined();
    expect(encrypt?.arguments[0]).toMatchObject({ replaceable: false, retained: false });
    expect(encrypt?.inputEvidence?.({})[0]).toMatchObject({ path: '$input.text' });
    expect(decrypt?.outputEvidence?.({ data: 'plain' })[0]).toMatchObject({ path: '$output.data' });
  });
});
