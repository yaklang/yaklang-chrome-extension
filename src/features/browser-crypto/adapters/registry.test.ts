import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CryptoAdapterOperation,
  CryptoAdapterScope,
  CryptoAdapterToolkit,
  PageCryptoAdapter,
} from './contract';
import { createCryptoAdapterRuntime } from './registry';

interface FakeDocument {
  addEventListener(type: string, listener: EventListener, capture?: boolean): void;
  removeEventListener(type: string, listener: EventListener, capture?: boolean): void;
  emitScriptLoad(): void;
}

function fakeDocument(): FakeDocument {
  const listeners = new Set<EventListener>();
  return {
    addEventListener(type, listener) {
      if (type === 'load') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'load') listeners.delete(listener);
    },
    emitScriptLoad() {
      for (const listener of listeners) {
        listener({ target: { tagName: 'SCRIPT' } } as unknown as Event);
      }
    },
  };
}

function toolkit(): CryptoAdapterToolkit {
  return {
    unique: (prefix) => `${prefix}-1`,
    byteLength: () => undefined,
    dataType: () => 'unknown',
    fingerprint: (value) => value,
    argument: (index, role, _value, replaceable, retained, summary) => ({
      index, role, dataType: 'unknown', replaceable, retained, summary,
    }),
    collectEvidence: () => [],
    defaultOutputEvidence: () => [],
    defaultAdaptInput: (value) => value,
    bytesForInput: () => undefined,
    bytesToBase64: () => '',
  };
}

function operation(owner: Record<string, unknown>): CryptoAdapterOperation {
  return {
    id: 'vendor.encrypt',
    operation: 'encrypt',
    owner,
    key: 'encrypt',
    resultMode: 'sync',
    describe: () => ({
      crypto: {
        adapterId: 'vendor', providerKind: 'library', family: 'symmetric', operation: 'encrypt',
      },
      inputIndex: 0,
      arguments: [],
    }),
    createWrapper: (_original, invoke) => function recordedVendor(this: unknown, ...args: unknown[]) {
      return invoke(this, args);
    },
  };
}

function adapter(owner: Record<string, unknown>, dynamic = true, onDiscover?: () => void): PageCryptoAdapter {
  return {
    manifest: {
      id: 'vendor', displayName: 'Vendor', providerKind: 'library', dynamic, globalPaths: ['Vendor'],
    },
    discover: () => {
      onDiscover?.();
      return [operation(owner)];
    },
  };
}

function scope(document: FakeDocument): CryptoAdapterScope {
  return {
    window: {
      document,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    } as unknown as Window,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('crypto adapter runtime', () => {
  it('preserves call semantics and restores the original property descriptor', () => {
    vi.useFakeTimers();
    const document = fakeDocument();
    const owner: Record<string, unknown> = {};
    const original = function originalEncrypt(this: { prefix: string }, value: string) {
      return `${this.prefix}:${value}`;
    };
    Object.defineProperty(owner, 'encrypt', {
      value: original, configurable: true, writable: false, enumerable: false,
    });
    const originalDescriptor = Object.getOwnPropertyDescriptor(owner, 'encrypt');
    let handle = '';
    const runtime = createCryptoAdapterRuntime([adapter(owner)], scope(document), toolkit(), {
      unique: () => 'wrapper-stable',
      invoke(_operation, target, thisArg, args, wrapperHandleId) {
        handle = wrapperHandleId;
        return Reflect.apply(target, thisArg, args);
      },
    });

    runtime.start();
    const wrapped = owner.encrypt as Function;
    expect(wrapped).not.toBe(original);
    expect(Reflect.apply(wrapped, { prefix: 'ok' }, ['value'])).toBe('ok:value');
    expect(handle).toBe('wrapper-stable');
    expect(runtime.wrapperFunction(handle)).toBe(wrapped);

    runtime.stop();
    expect(Object.getOwnPropertyDescriptor(owner, 'encrypt')).toEqual(originalDescriptor);
    expect(runtime.wrapperFunction(handle)).toBeUndefined();
  });

  it('keeps a stable wrapper handle across stop and restart in one document', () => {
    vi.useFakeTimers();
    const document = fakeDocument();
    const owner = { encrypt: (value: string) => value } as Record<string, unknown>;
    let generated = 0;
    const runtime = createCryptoAdapterRuntime([adapter(owner)], scope(document), toolkit(), {
      unique: () => `wrapper-${++generated}`,
      invoke(_operation, target, thisArg, args) { return Reflect.apply(target, thisArg, args); },
    });

    runtime.start();
    expect(runtime.wrapperFunction('wrapper-1')).toBe(owner.encrypt);
    runtime.stop();
    runtime.start();

    expect(generated).toBe(1);
    expect(runtime.wrapperFunction('wrapper-1')).toBe(owner.encrypt);
    runtime.stop();
  });

  it('does not overwrite a page replacement during cleanup', () => {
    vi.useFakeTimers();
    const document = fakeDocument();
    const original = (value: string) => value;
    const replacement = (value: string) => `page:${value}`;
    const owner = { encrypt: original } as Record<string, unknown>;
    const runtime = createCryptoAdapterRuntime([adapter(owner)], scope(document), toolkit(), {
      unique: () => 'wrapper-1',
      invoke(_operation, target, thisArg, args) { return Reflect.apply(target, thisArg, args); },
    });

    runtime.start();
    owner.encrypt = replacement;
    runtime.stop();

    expect(owner.encrypt).toBe(replacement);
  });

  it('uses only bounded retries and reacts to script loads for dynamic adapters', () => {
    vi.useFakeTimers();
    const document = fakeDocument();
    const owner = { encrypt: (value: string) => value } as Record<string, unknown>;
    let discoveries = 0;
    const runtime = createCryptoAdapterRuntime(
      [adapter(owner, true, () => { discoveries += 1; })],
      scope(document),
      toolkit(),
      {
        unique: () => 'wrapper-1',
        invoke(_operation, target, thisArg, args) { return Reflect.apply(target, thisArg, args); },
      },
    );

    runtime.start();
    expect(discoveries).toBe(1);
    vi.runAllTimers();
    expect(discoveries).toBe(5);
    expect(vi.getTimerCount()).toBe(0);
    document.emitScriptLoad();
    expect(discoveries).toBe(6);
    runtime.stop();
    document.emitScriptLoad();
    expect(discoveries).toBe(6);
  });

  it('installs returned session operations immediately and restores them across restart', () => {
    vi.useFakeTimers();
    const document = fakeDocument();
    const sessionPrototype = { update: (value: string) => `session:${value}` };
    const session = Object.create(sessionPrototype) as Record<string, unknown>;
    const originalUpdate = session.update;
    const owner = { create: () => session } as Record<string, unknown>;
    const sessionOperation = operation(session);
    sessionOperation.id = 'vendor.session-1.update';
    sessionOperation.operation = 'session.update';
    sessionOperation.key = 'update';
    const factoryOperation: CryptoAdapterOperation = {
      ...operation(owner),
      id: 'vendor.create',
      operation: 'session.create',
      key: 'create',
      describe: () => ({
        crypto: { adapterId: 'vendor', providerKind: 'library', family: 'symmetric', operation: 'session.create' },
        inputIndex: -1,
        arguments: [],
        discoverResult: () => [sessionOperation],
      }),
    };
    const factoryAdapter: PageCryptoAdapter = {
      manifest: { id: 'vendor', displayName: 'Vendor', providerKind: 'library', dynamic: true, globalPaths: ['Vendor'] },
      discover: () => [factoryOperation],
    };
    let generated = 0;
    const runtime = createCryptoAdapterRuntime([factoryAdapter], scope(document), toolkit(), {
      unique: () => `wrapper-${++generated}`,
      invoke(adapterOperation, target, thisArg, args, _wrapperHandleId, installDynamic) {
        const output = Reflect.apply(target, thisArg, args);
        installDynamic(adapterOperation.describe(thisArg, args, toolkit()).discoverResult?.(output) || []);
        return output;
      },
    });

    runtime.start();
    const returned = Reflect.apply(owner.create as Function, owner, []) as Record<string, unknown>;
    const firstWrapped = returned.update as Function;
    expect(firstWrapped).not.toBe(originalUpdate);
    expect(Reflect.apply(firstWrapped, returned, ['value'])).toBe('session:value');
    expect(runtime.wrapperFunction('wrapper-2')).toBe(firstWrapped);

    runtime.stop();
    expect(session.update).toBe(originalUpdate);
    expect(Object.prototype.hasOwnProperty.call(session, 'update')).toBe(false);
    runtime.start();
    expect(session.update).not.toBe(originalUpdate);
    expect(Object.prototype.hasOwnProperty.call(session, 'update')).toBe(true);
    expect(runtime.wrapperFunction('wrapper-2')).toBe(session.update);
    runtime.stop();
  });

  it('skips non-configurable accessors without invoking their getter', () => {
    vi.useFakeTimers();
    const document = fakeDocument();
    const getter = vi.fn(() => () => 'secret');
    const owner: Record<string, unknown> = {};
    Object.defineProperty(owner, 'encrypt', { get: getter, configurable: false });
    const runtime = createCryptoAdapterRuntime([adapter(owner)], scope(document), toolkit(), {
      unique: () => 'wrapper-1',
      invoke: () => undefined,
    });

    runtime.start();
    expect(getter).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(owner, 'encrypt')?.get).toBe(getter);
    runtime.stop();
  });
});
