import type {
  BrowserCryptoProviderKind,
  BrowserPageCallableValueEncoding,
  BrowserRecordingCallArgument,
  BrowserRecordingCrypto,
  BrowserRecordingValueEvidence,
} from '@/types/models';

export type CallableOperationKind = 'encrypt' | 'decrypt' | 'sign' | 'verify' | 'digest';

export interface CryptoAdapterManifest {
  id: string;
  displayName: string;
  providerKind: BrowserCryptoProviderKind;
  dynamic: boolean;
  globalPaths: string[];
}

export interface CryptoAdapterScope {
  window: Window;
  crypto?: Crypto;
}

export interface CryptoAdapterToolkit {
  unique(prefix: string): string;
  byteLength(value: unknown): number | undefined;
  dataType(value: unknown): string;
  fingerprint(value: string): string;
  argument(
    index: number,
    role: BrowserRecordingCallArgument['role'],
    value: unknown,
    replaceable: boolean,
    retained: boolean,
    summary?: string,
  ): BrowserRecordingCallArgument;
  collectEvidence(value: unknown, path: string): BrowserRecordingValueEvidence[];
  defaultOutputEvidence(value: unknown): BrowserRecordingValueEvidence[];
  defaultAdaptInput(value: unknown, originalInput: unknown): unknown;
  bytesForInput(value: unknown): Uint8Array | undefined;
  bytesToBase64(value: Uint8Array): string;
}

export interface CryptoAdapterInvocationPlan {
  crypto: BrowserRecordingCrypto;
  inputIndex: number;
  arguments: BrowserRecordingCallArgument[];
  callableKind?: CallableOperationKind;
  outputEncoding?: BrowserPageCallableValueEncoding;
  inputEvidence?(value: unknown): BrowserRecordingValueEvidence[];
  outputEvidence?(value: unknown): BrowserRecordingValueEvidence[];
  outputError?(value: unknown): string | undefined;
  adaptInput?(value: unknown): unknown;
  discoverResult?(value: unknown): CryptoAdapterOperation[];
}

export interface CryptoAdapterOperation {
  id: string;
  operation: string;
  owner: Record<string, unknown>;
  key: string;
  invocationMode?: 'call' | 'construct';
  resultMode: 'sync' | 'promise';
  describe(thisArg: unknown, args: unknown[], toolkit: CryptoAdapterToolkit): CryptoAdapterInvocationPlan;
  createWrapper(
    original: Function,
    invoke: (thisArg: unknown, args: unknown[]) => unknown,
  ): Function;
}

export interface PageCryptoAdapter {
  manifest: CryptoAdapterManifest;
  discover(scope: CryptoAdapterScope): CryptoAdapterOperation[];
}
