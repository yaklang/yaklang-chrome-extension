import type { CryptoAdapterManifest } from './contract';

export const webCryptoManifest: CryptoAdapterManifest = {
  id: 'webcrypto',
  displayName: 'WebCrypto',
  providerKind: 'native',
  dynamic: false,
  globalPaths: ['crypto.subtle'],
};

export const cryptoJsManifest: CryptoAdapterManifest = {
  id: 'cryptojs',
  displayName: 'CryptoJS',
  providerKind: 'library',
  dynamic: true,
  globalPaths: ['CryptoJS'],
};

export const jsEncryptManifest: CryptoAdapterManifest = {
  id: 'jsencrypt',
  displayName: 'JSEncrypt',
  providerKind: 'library',
  dynamic: true,
  globalPaths: ['JSEncrypt.prototype'],
};

export const smCryptoManifest: CryptoAdapterManifest = {
  id: 'sm-crypto',
  displayName: 'sm-crypto',
  providerKind: 'library',
  dynamic: true,
  globalPaths: ['smCrypto', 'sm2', 'sm3', 'sm4'],
};

export const nodeForgeManifest: CryptoAdapterManifest = {
  id: 'node-forge',
  displayName: 'node-forge',
  providerKind: 'library',
  dynamic: true,
  globalPaths: ['forge'],
};

export const jsrsasignManifest: CryptoAdapterManifest = {
  id: 'jsrsasign',
  displayName: 'jsrsasign',
  providerKind: 'library',
  dynamic: true,
  globalPaths: ['KJUR.crypto.Signature', 'KJUR.jws.JWS', 'KEYUTIL'],
};

export const joseManifest: CryptoAdapterManifest = {
  id: 'jose',
  displayName: 'jose',
  providerKind: 'library',
  dynamic: true,
  globalPaths: ['jose'],
};

export const libsodiumManifest: CryptoAdapterManifest = {
  id: 'libsodium',
  displayName: 'libsodium.js',
  providerKind: 'library',
  dynamic: true,
  globalPaths: ['sodium'],
};

export const tweetNaclManifest: CryptoAdapterManifest = {
  id: 'tweetnacl',
  displayName: 'TweetNaCl.js',
  providerKind: 'library',
  dynamic: true,
  globalPaths: ['nacl'],
};

export const nobleManifest: CryptoAdapterManifest = {
  id: 'noble',
  displayName: 'noble-*',
  providerKind: 'library',
  dynamic: true,
  globalPaths: ['noble', 'nobleCiphers', 'nobleHashes', 'nobleCurves'],
};

export const openPgpManifest: CryptoAdapterManifest = {
  id: 'openpgp',
  displayName: 'OpenPGP.js',
  providerKind: 'library',
  dynamic: true,
  globalPaths: ['openpgp'],
};

export const CRYPTO_ADAPTER_MANIFESTS: Readonly<Record<string, CryptoAdapterManifest>> = Object.freeze(
  Object.fromEntries([
    webCryptoManifest,
    cryptoJsManifest,
    jsEncryptManifest,
    smCryptoManifest,
    nodeForgeManifest,
    jsrsasignManifest,
    joseManifest,
    libsodiumManifest,
    tweetNaclManifest,
    nobleManifest,
    openPgpManifest,
  ].map((manifest) => [manifest.id, Object.freeze(manifest)])),
);

export function cryptoAdapterLabel(adapterId: string): string {
  return CRYPTO_ADAPTER_MANIFESTS[adapterId]?.displayName || adapterId;
}
