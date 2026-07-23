import { describe, expect, it } from 'vitest';
import type { BrowserDeepCaptureFrame } from '@/types/models';
import { rankBusinessFrames } from './business-frame-ranker';

function frame(id: string, overrides: Partial<BrowserDeepCaptureFrame> = {}): BrowserDeepCaptureFrame {
  return {
    id,
    index: 0,
    functionName: 'functionName',
    scriptId: id,
    url: 'https://example.test/app.js',
    lineNumber: 1,
    columnNumber: 1,
    scopes: [],
    thisPreview: 'Window',
    sourceKind: 'page',
    libraryFrame: false,
    functionInspection: { resolved: true, parameterCount: 1, riskFlags: [] },
    ...overrides,
  };
}

describe('business frame ranker', () => {
  it('prefers a safe page closure over recorder and dependency frames', () => {
    const result = rankBusinessFrames([
      frame('hook', { sourceKind: 'extension-hook', libraryFrame: true, functionName: 'recordedFetch' }),
      frame('library', { index: 1, sourceKind: 'library', libraryFrame: true, functionName: 'encrypt' }),
      frame('business', {
        index: 2,
        functionName: 'buildLoginEnvelope',
        scopes: [{ type: 'closure', variables: [{ name: 'payload', type: 'object', preview: 'Object' }] }],
      }),
    ]);

    expect(result.recommendedFrameId).toBe('business');
    expect(result.automaticCapture).toMatchObject({ state: 'ready', frameId: 'business' });
    expect(result.frames.find((item) => item.id === 'hook')?.businessScore).toBe(0);
    expect(result.frames.find((item) => item.id === 'business')?.businessReasons).toContain('具有可分析参数或闭包现场');
  });

  it('penalizes a page function that would resend the real request', () => {
    const result = rankBusinessFrames([
      frame('network', { functionName: 'submitLogin', functionInspection: { resolved: true, riskFlags: ['network'] } }),
      frame('pure', { index: 2, functionName: 'buildEnvelope' }),
    ]);
    expect(result.recommendedFrameId).toBe('pure');
    expect(result.frames[0].businessScore).toBeLessThan(result.frames[1].businessScore || 0);
  });

  it('uses a common recorded-stack ancestor without hard-coded page names', () => {
    const result = rankBusinessFrames([
      frame('near', { index: 1, functionName: '_0x91' }),
      frame('common', { index: 3, functionName: '_0x47' }),
    ], [{
      functionName: '_0x47', url: 'https://example.test/app.js', support: 3, averageDepth: 1,
    }]);

    expect(result.recommendedFrameId).toBe('common');
    expect(result.frames[1].businessReasons).toContain('3 个密码调用的共同业务祖先');
  });

  it('captures the nearest side-effecting common ancestor as a request transaction instead of onclick', () => {
    const hints = [
      { functionName: 'sendDataAesRsa', url: 'https://example.test/app.js', support: 3, averageDepth: 1 },
      { functionName: 'onclick', url: 'https://example.test/', support: 3, averageDepth: 2 },
    ];
    const result = rankBusinessFrames([
      frame('sender', {
        index: 2,
        functionName: 'sendDataAesRsa',
        functionInspection: {
          resolved: true,
          parameterCount: 1,
          parameterNames: ['url'],
          riskFlags: ['network', 'dom', 'navigation'],
        },
      }),
      frame('onclick', {
        index: 3,
        functionName: 'onclick',
        url: 'https://example.test/',
        thisPreview: 'HTMLButtonElement',
        functionInspection: {
          resolved: true,
          parameterCount: 1,
          parameterNames: ['event'],
          riskFlags: [],
        },
      }),
    ], hints);

    expect(result.recommendedFrameId).toBe('sender');
    expect(result.automaticCapture).toMatchObject({
      state: 'ready',
      strategy: 'request-transaction',
      frameId: 'sender',
    });
  });

  it('does not guess between equally supported safe page functions', () => {
    const result = rankBusinessFrames([
      frame('first', { index: 2, functionName: '_0x1' }),
      frame('second', { index: 2, functionName: '_0x2' }),
    ]);
    expect(result.automaticCapture.state).toBe('ambiguous');
  });

  it('does not ignore recorded stack hints to capture an unrelated safe function', () => {
    const result = rankBusinessFrames([
      frame('unrelated', { index: 1, functionName: 'differentFunction' }),
    ], [{ functionName: 'expectedEnvelope', url: 'https://example.test/app.js', support: 2, averageDepth: 1 }]);
    expect(result.automaticCapture.state).toBe('unavailable');
    expect(result.automaticCapture.reason).toContain('没有与暂停现场唯一对应');
  });

  it('blocks automatic capture when the only resolved business function has side effects', () => {
    const result = rankBusinessFrames([
      frame('sender', { functionName: 'submit', functionInspection: { resolved: true, riskFlags: ['network'] } }),
    ]);
    expect(result.automaticCapture).toMatchObject({ state: 'blocked', frameId: 'sender' });
  });

  it('is deterministic when candidates have the same evidence', () => {
    const first = frame('a', { index: 2, functionName: '_0x1' });
    const second = frame('b', { index: 2, functionName: '_0x2' });
    expect(rankBusinessFrames([second, first]).recommendedFrameId).toBe('a');
  });
});
