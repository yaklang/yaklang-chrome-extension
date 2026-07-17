import { vi, describe, expect, it } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: {} }));
Object.assign(globalThis, { Node: class Node {}, Element: class Element {} });

import { executeInUserScriptWorld } from './execution-adapter';

describe('page execution serializer', () => {
  it('serializes BigInt and circular values without throwing', async () => {
    const response = await executeInUserScriptWorld({
      operation: 'eval', mode: 'expression',
      code: '(() => { const value = { big: 42n }; value.self = value; return value; })()', timeoutMs: 500,
    }, () => { const value: Record<string, unknown> = { big: 42n }; value.self = value; return value; });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result.value).toMatchObject({ big: { $type: 'bigint', value: '42' }, self: { $type: 'circular' } });
      expect(response.result.truncated).toBe(false);
    }
  });

  it('distinguishes expression and program syntax', async () => {
    const expression = await executeInUserScriptWorld({ operation: 'eval', mode: 'expression', code: '1 + 1', timeoutMs: 500 }, () => 1 + 1);
    const program = await executeInUserScriptWorld({ operation: 'eval', mode: 'program', code: 'const answer = 40; answer + 2', timeoutMs: 500 }, () => { const answer = 40; return answer + 2; });
    expect(expression.ok && expression.result.value).toBe(2);
    expect(program.ok && program.result.value).toBe(42);
  });
});
