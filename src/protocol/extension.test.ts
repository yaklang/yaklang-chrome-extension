import { describe, expect, it } from 'vitest';
import { parseExtensionRequest } from './extension';

describe('extension request schemas', () => {
  it('rejects unknown fields', () => {
    expect(() => parseExtensionRequest({ action: 'panel.update', payload: { enabled: true, unexpected: true } })).toThrow('unexpected');
  });

  it('accepts split panel policy and explicit Eval mode', () => {
    expect(parseExtensionRequest({
      action: 'panel.update',
      payload: { displayMode: 'active-task', siteMode: 'denylist', siteOrigins: ['https://example.test'] },
    }).action).toBe('panel.update');
    expect(parseExtensionRequest({
      action: 'context.eval', payload: { mode: 'program', code: '1 + 1', timeoutMs: 500 },
    }).action).toBe('context.eval');
  });
});
