import { describe, expect, it } from 'vitest';
import { normalizeBypass } from './presentation';

describe('normalizeBypass', () => {
  it('cleans blank lines only when the proxy profile is saved', () => {
    expect(normalizeBypass([' localhost ', '', '  ', '<local>'])).toEqual(['localhost', '<local>']);
  });
});
