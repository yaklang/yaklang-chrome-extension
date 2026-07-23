import { describe, expect, it } from 'vitest';
import { parseFunctionParameterNames } from './function-parameters';

describe('deep-capture function parameter parser', () => {
  it.each([
    ['async function buildLoginEnvelope(password, account = "analyst") {}', ['password', 'account']],
    ['encrypt(value, options = { mode: "CBC", fields: ["a", "b"] }) {}', ['value', 'options']],
    ['(payload, ...rest) => payload', ['payload', 'rest']],
    ['async value => value', ['value']],
    ['function transform({ value }, [key]) {}', ['arg0', 'arg1']],
  ])('reads runtime source parameters from %s', (source, expected) => {
    expect(parseFunctionParameterNames(source)).toEqual(expected);
  });

  it('keeps the parser bounded', () => {
    expect(parseFunctionParameterNames('(a, b, c) => a', 2)).toEqual(['a', 'b']);
  });
});
