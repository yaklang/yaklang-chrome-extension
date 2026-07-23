import { describe, expect, it } from 'vitest';
import { acquireTransformExecutionGate, createTransformExecutionGate } from './concurrency';

describe('browser transform concurrency gate', () => {
  it('transfers a released permit to the oldest waiter without overcommitting', async () => {
    const gate = createTransformExecutionGate();
    const releaseFirst = await acquireTransformExecutionGate(gate, 1, 2);
    const second = acquireTransformExecutionGate(gate, 1, 2);

    expect(gate).toMatchObject({ active: 1, queued: 1 });
    releaseFirst();

    // The woken waiter owns the permit before its promise continuation runs.
    const third = acquireTransformExecutionGate(gate, 1, 2);
    expect(gate).toMatchObject({ active: 1, queued: 2 });

    const releaseSecond = await second;
    expect(gate).toMatchObject({ active: 1, queued: 1 });
    releaseSecond();

    const releaseThird = await third;
    expect(gate).toMatchObject({ active: 1, queued: 0 });
    releaseThird();
    releaseThird();
    expect(gate).toMatchObject({ active: 0, queued: 0 });
  });

  it('fails before adding work beyond the bounded queue', async () => {
    const gate = createTransformExecutionGate();
    const release = await acquireTransformExecutionGate(gate, 1, 1);
    const waiting = acquireTransformExecutionGate(gate, 1, 1);

    await expect(acquireTransformExecutionGate(gate, 1, 1)).rejects.toThrow('队列已满');
    release();
    const releaseWaiting = await waiting;
    releaseWaiting();
  });
});
