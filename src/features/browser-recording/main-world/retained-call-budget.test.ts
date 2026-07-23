import { describe, expect, it } from 'vitest';
import { RetainedCallBudget } from './retained-call-budget';

describe('RetainedCallBudget', () => {
  it('evicts oldest handles by count without exceeding the byte budget', () => {
    const budget = new RetainedCallBudget<{ id: string; retainedBytes: number; value: string }>({
      maxCount: 2,
      maxBytes: 10,
      maxEntryBytes: 8,
    });
    expect(budget.add({ id: 'a', retainedBytes: 4, value: 'a' })).toBe(true);
    expect(budget.add({ id: 'b', retainedBytes: 4, value: 'b' })).toBe(true);
    expect(budget.add({ id: 'c', retainedBytes: 4, value: 'c' })).toBe(true);
    expect(budget.get('a')).toBeUndefined();
    expect(budget.get('b')?.value).toBe('b');
    expect(budget.retainedBytes).toBe(8);
  });

  it('rejects an oversized handle and releases accounting on delete and clear', () => {
    const budget = new RetainedCallBudget({ maxCount: 4, maxBytes: 8, maxEntryBytes: 5 });
    expect(budget.add({ id: 'too-large', retainedBytes: 6 })).toBe(false);
    expect(budget.add({ id: 'a', retainedBytes: 5 })).toBe(true);
    expect(budget.add({ id: 'b', retainedBytes: 5 })).toBe(true);
    expect(budget.get('a')).toBeUndefined();
    expect(budget.retainedBytes).toBe(5);
    expect(budget.delete('b')).toBe(true);
    expect(budget.retainedBytes).toBe(0);
    budget.add({ id: 'c', retainedBytes: 3 });
    budget.clear();
    expect(budget.size).toBe(0);
    expect(budget.retainedBytes).toBe(0);
  });
});
