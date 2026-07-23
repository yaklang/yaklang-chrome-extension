import { describe, expect, it } from 'vitest';
import { callableExecutionPolicy, settleCallableResult } from './execution';

describe('page callable execution contract', () => {
  it('settles a declared Promise result', async () => {
    await expect(settleCallableResult(
      Promise.resolve({ signature: 'signed' }),
      callableExecutionPolicy('promise'),
    )).resolves.toEqual({ signature: 'signed' });
  });

  it('supports auto mode for captured business functions', async () => {
    await expect(settleCallableResult('ciphertext', callableExecutionPolicy('auto'))).resolves.toBe('ciphertext');
    await expect(settleCallableResult(Promise.resolve('ciphertext'), callableExecutionPolicy('auto'))).resolves.toBe('ciphertext');
  });

  it('fails closed when an asynchronous result exceeds its deadline', async () => {
    const never = new Promise(() => undefined);
    await expect(settleCallableResult(never, callableExecutionPolicy('promise', 250)))
      .rejects.toThrow('页面函数异步执行超过 250 ms');
  });

  it('rejects a result that violates its declared mode', async () => {
    await expect(settleCallableResult(Promise.resolve('late'), callableExecutionPolicy('sync')))
      .rejects.toThrow('声明为同步执行');
    await expect(settleCallableResult('early', callableExecutionPolicy('promise')))
      .rejects.toThrow('声明为异步执行');
  });
});
