import { describe, expect, it } from 'vitest';
import type { BrowserDeepCaptureFrame } from '@/types/models';
import { capturedCallableSample } from './callable-sample';

function frame(): BrowserDeepCaptureFrame {
  return {
    id: 'frame-1', index: 1, functionName: 'buildLoginEnvelope', scriptId: '7', url: 'https://example.test/app.js',
    lineNumber: 12, columnNumber: 3, thisPreview: 'Window', sourceKind: 'page', libraryFrame: false,
    functionInspection: { resolved: true, parameterCount: 3, parameterNames: ['password', 'account', 'attempt'], riskFlags: [] },
    scopes: [
      { type: 'closure', variables: [{ name: 'account', type: 'string', preview: 'closure-account' }] },
      { type: 'local', variables: [
        { name: 'password', type: 'string', preview: 'secret-value' },
        { name: 'account', type: 'string', preview: 'analyst' },
        { name: 'attempt', type: 'number', preview: '2' },
        { name: 'unrelated', type: 'string', preview: 'ignored' },
      ] },
    ],
  };
}

describe('captured callable replay sample', () => {
  it('uses exact parameters from the nearest authorized scope only', () => {
    expect(capturedCallableSample(frame())).toEqual({
      body: '{\n  "password": "secret-value",\n  "account": "analyst",\n  "attempt": 2\n}',
      label: 'buildLoginEnvelope · 暂停现场',
    });
  });

  it('does not invent values for unresolved parameters', () => {
    const input = frame();
    input.functionInspection!.parameterNames = ['missing'];
    expect(capturedCallableSample(input)).toBeUndefined();
  });

  it('does not use a truncated scope preview as a replay value', () => {
    const input = frame();
    input.functionInspection!.parameterNames = ['password'];
    input.scopes[1].variables[0].detailTruncated = true;
    expect(capturedCallableSample(input)).toBeUndefined();
  });
});
