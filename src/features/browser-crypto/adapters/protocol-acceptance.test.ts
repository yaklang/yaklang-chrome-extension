import { describe, expect, it } from 'vitest';
import { KEYUTIL, KJUR } from 'jsrsasign';
import {
  CompactEncrypt,
  CompactSign,
  SignJWT,
  compactDecrypt,
  compactVerify,
  jwtVerify,
} from 'jose';
import type { CryptoAdapterToolkit } from './contract';
import { jsrsasignAdapter } from './jsrsasign';
import { joseAdapter } from './jose';

function toolkit(): CryptoAdapterToolkit {
  return {
    unique: (prefix) => `${prefix}-acceptance`,
    byteLength: (value) => typeof value === 'string' ? new TextEncoder().encode(value).byteLength
      : ArrayBuffer.isView(value) ? value.byteLength
        : value instanceof ArrayBuffer ? value.byteLength : undefined,
    dataType: (value) => Object.prototype.toString.call(value).slice(8, -1),
    fingerprint: (value) => `opaque:${value.length}`,
    argument: (index, role, value, replaceable, retained, summary) => ({
      index, role, dataType: typeof value, replaceable, retained, summary,
    }),
    collectEvidence: (value, path) => [{
      path, fingerprint: `evidence:${String(value).length}`, encoding: 'text', byteLength: String(value).length,
    }],
    defaultOutputEvidence: () => [],
    defaultAdaptInput: (value) => value,
    bytesForInput: (value) => value instanceof Uint8Array ? value : undefined,
    bytesToBase64: (value) => Buffer.from(value).toString('base64'),
  };
}

describe('modern protocol adapter acceptance', () => {
  it('tracks a real jsrsasign Signature session and independently verifies its output', { timeout: 15_000 }, () => {
    const operations = jsrsasignAdapter.discover({
      window: { KJUR, KEYUTIL } as unknown as Window,
    });
    const constructor = operations.find((item) => item.operation === 'Signature.create');
    const createPlan = constructor?.describe(undefined, [{ alg: 'SHA256withRSA' }], toolkit());
    const keypair = KEYUTIL.generateKeypair('RSA', 1024);
    const signer = new KJUR.crypto.Signature({ alg: 'SHA256withRSA' });
    const stages = createPlan?.discoverResult?.(signer) || [];
    const init = stages.find((item) => item.operation === 'Signature.init');
    const update = stages.find((item) => item.operation === 'Signature.updateString');
    const final = stages.find((item) => item.operation === 'Signature.sign');
    const canonical = 'POST\n/api/order\naccount=admin&nonce=1700000000';

    const plans = [
      init?.describe(signer, [keypair.prvKeyObj], toolkit()),
      update?.describe(signer, [canonical], toolkit()),
      final?.describe(signer, [], toolkit()),
    ];
    signer.init(keypair.prvKeyObj);
    signer.updateString(canonical);
    const signature = signer.sign();

    const verifier = new KJUR.crypto.Signature({ alg: 'SHA256withRSA' });
    verifier.init(keypair.pubKeyObj);
    verifier.updateString(canonical);
    expect(verifier.verify(signature)).toBe(true);
    expect(plans.map((plan) => plan?.crypto.state?.phase)).toEqual(['init', 'update', 'final']);
    expect(new Set(plans.map((plan) => plan?.crypto.state?.correlationId))).toEqual(new Set(['jsrsasign-signature-acceptance']));

    const jwkOperation = operations.find((item) => item.operation === 'KEYUTIL.getJWK');
    const jwkPlan = jwkOperation?.describe(KEYUTIL as unknown as Record<string, unknown>, [keypair.prvKeyObj], toolkit());
    const privateJwk = KEYUTIL.getJWK(keypair.prvKeyObj);
    expect(privateJwk).toHaveProperty('d');
    expect(jwkPlan?.outputEvidence?.(privateJwk)).toEqual([]);
  });

  it('tracks real jose Promise builders and verifies/decrypts their compact envelopes independently', async () => {
    const root = {
      SignJWT, CompactSign, CompactEncrypt, jwtVerify, compactVerify, compactDecrypt,
      jwtDecrypt: async () => undefined,
      importJWK: async () => undefined,
      exportJWK: async () => undefined,
    };
    const operations = joseAdapter.discover({ window: { jose: root } as unknown as Window });
    const secret = crypto.getRandomValues(new Uint8Array(32));

    const signJwtConstructor = operations.find((item) => item.operation === 'SignJWT.create');
    const createPlan = signJwtConstructor?.describe(undefined, [{ account: 'admin' }], toolkit());
    const builder = new SignJWT({ account: 'admin' });
    const stages = createPlan?.discoverResult?.(builder) || [];
    const headerPlan = stages.find((item) => item.operation === 'SignJWT.setProtectedHeader')
      ?.describe(builder, [{ alg: 'HS256' }], toolkit());
    builder.setProtectedHeader({ alg: 'HS256' });
    const signOperation = stages.find((item) => item.operation === 'SignJWT.sign');
    const signPlan = signOperation?.describe(builder, [secret], toolkit());
    const tokenPromise = builder.sign(secret);
    const token = await tokenPromise;
    const verified = await jwtVerify(token, secret, { algorithms: ['HS256'] });

    expect(verified.payload.account).toBe('admin');
    expect(signOperation?.resultMode).toBe('promise');
    expect(headerPlan?.crypto).toMatchObject({ algorithm: 'HS256', state: { phase: 'update' } });
    expect(signPlan?.crypto).toMatchObject({ algorithm: 'HS256', state: { phase: 'final' } });
    expect(signPlan?.crypto.state?.correlationId).toBe(createPlan?.crypto.state?.correlationId);

    const payload = new TextEncoder().encode('canonical-request');
    const jws = await new CompactSign(payload).setProtectedHeader({ alg: 'HS256' }).sign(secret);
    const checked = await compactVerify(jws, secret, { algorithms: ['HS256'] });
    expect(new TextDecoder().decode(checked.payload)).toBe('canonical-request');

    const jwe = await new CompactEncrypt(payload).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).encrypt(secret);
    const decrypted = await compactDecrypt(jwe, secret, { keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'] });
    expect(new TextDecoder().decode(decrypted.plaintext)).toBe('canonical-request');
    expect(operations.find((item) => item.operation === 'CompactVerify.verify')?.resultMode).toBe('promise');
    expect(operations.find((item) => item.operation === 'CompactDecrypt.decrypt')?.resultMode).toBe('promise');
  });
});
