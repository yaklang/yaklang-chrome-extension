import type {
  BrowserRecordingTransform,
  BrowserRecordingValueEvidence,
} from '@/types/models';

export interface EncodingTransformEvent {
  operation: string;
  transform: BrowserRecordingTransform;
  inputs: BrowserRecordingValueEvidence[];
  outputs: BrowserRecordingValueEvidence[];
  byteLength?: number;
  resultByteLength?: number;
  inputPreview?: string;
  outputPreview?: string;
  stack?: string;
  scriptUrl?: string;
}

export interface EncodingTransformHost {
  byteLength(value: unknown): number | undefined;
  preview(value: unknown): string | undefined;
  collectEvidence(value: unknown, path: string): BrowserRecordingValueEvidence[];
  stackInfo(): { stack?: string; scriptUrl?: string };
  emit(event: EncodingTransformEvent): void;
}

export interface EncodingTransformRuntime {
  start(): void;
  stop(): void;
}

export function createEncodingTransformRuntime(
  scope: Window,
  host: EncodingTransformHost,
): EncodingTransformRuntime {
  const originalBtoa = scope.btoa;
  const originalAtob = scope.atob;
  let active = false;
  let wrappedBtoa: typeof scope.btoa | undefined;
  let wrappedAtob: typeof scope.atob | undefined;

  const binaryStringEvidence = (value: string, path: string): BrowserRecordingValueEvidence[] => {
    const output = host.collectEvidence(value, path);
    try {
      Reflect.apply(originalBtoa, scope, [value]);
      const bytes = Uint8Array.from(value, (character) => character.charCodeAt(0));
      output.push(...host.collectEvidence(bytes, `${path}:bytes`));
    } catch {
      // Native btoa remains the authority for binary-string validity.
    }
    return output.slice(0, 48);
  };

  return {
    start() {
      if (active) return;
      active = true;
      wrappedBtoa = function recordedBtoa(input: string): string {
        const output = Reflect.apply(originalBtoa, scope, [input]);
        try {
          host.emit({
            operation: 'base64.encode',
            transform: {
              adapterId: 'native.base64',
              providerKind: 'native',
              category: 'encoding',
              phase: 'output',
            },
            inputs: binaryStringEvidence(input, '$input'),
            outputs: host.collectEvidence(output, '$output'),
            inputPreview: host.preview(input),
            outputPreview: host.preview(output),
            byteLength: host.byteLength(input),
            resultByteLength: host.byteLength(output),
            ...host.stackInfo(),
          });
        } catch {
          // Encoding evidence is best effort.
        }
        return output;
      };
      wrappedAtob = function recordedAtob(input: string): string {
        const output = Reflect.apply(originalAtob, scope, [input]);
        try {
          host.emit({
            operation: 'base64.decode',
            transform: {
              adapterId: 'native.base64',
              providerKind: 'native',
              category: 'encoding',
              phase: 'output',
            },
            inputs: host.collectEvidence(input, '$input'),
            outputs: binaryStringEvidence(output, '$output'),
            inputPreview: host.preview(input),
            outputPreview: host.preview(output),
            byteLength: host.byteLength(input),
            resultByteLength: host.byteLength(output),
            ...host.stackInfo(),
          });
        } catch {
          // Encoding evidence is best effort.
        }
        return output;
      };
      scope.btoa = wrappedBtoa;
      scope.atob = wrappedAtob;
    },
    stop() {
      if (!active) return;
      active = false;
      if (wrappedBtoa && scope.btoa === wrappedBtoa) scope.btoa = originalBtoa;
      if (wrappedAtob && scope.atob === wrappedAtob) scope.atob = originalAtob;
      wrappedBtoa = undefined;
      wrappedAtob = undefined;
    },
  };
}
