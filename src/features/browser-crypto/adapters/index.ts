import type { PageCryptoAdapter } from './contract';
import { cryptoJsAdapter } from './cryptojs';
import { jsEncryptAdapter } from './jsencrypt';
import { webCryptoAdapter } from './webcrypto';
import { smCryptoAdapter } from './sm-crypto';
import { nodeForgeAdapter } from './node-forge';
import { jsrsasignAdapter } from './jsrsasign';
import { joseAdapter } from './jose';

export const PAGE_CRYPTO_ADAPTERS: PageCryptoAdapter[] = [
  webCryptoAdapter,
  cryptoJsAdapter,
  jsEncryptAdapter,
  smCryptoAdapter,
  nodeForgeAdapter,
  jsrsasignAdapter,
  joseAdapter,
];

export type {
  CallableOperationKind,
  CryptoAdapterInvocationPlan,
  CryptoAdapterManifest,
  CryptoAdapterOperation,
  CryptoAdapterScope,
  CryptoAdapterToolkit,
  PageCryptoAdapter,
} from './contract';

export { createCryptoAdapterRuntime } from './registry';
export type { CryptoAdapterRuntime, CryptoAdapterRuntimeHost } from './registry';
export { CRYPTO_ADAPTER_MANIFESTS, cryptoAdapterLabel } from './catalog';
