import { describe, expect, it } from 'vitest';
import { inferBusinessFrameHints, parseRecordingStack } from './stack-hints';

describe('recording stack business hints', () => {
  it('removes recorder and dependency frames while keeping page callers', () => {
    const frames = parseRecordingStack([
      'Error',
      '    at recordedEncrypt (chrome-extension://extension/page-recorder-main-world.js:1:10)',
      '    at Object.encrypt (https://example.test/assets/crypto-js.min.js:2:20)',
      '    at buildEnvelope (https://example.test/assets/app.js?v=7:41:9)',
      '    at submitLogin (https://example.test/assets/app.js?v=7:63:5)',
    ].join('\n'));

    expect(frames).toEqual([
      { functionName: 'buildEnvelope', url: 'https://example.test/assets/app.js', depth: 0 },
      { functionName: 'submitLogin', url: 'https://example.test/assets/app.js', depth: 1 },
    ]);
  });

  it('finds the nearest common business ancestor across independently named crypto calls', () => {
    const hints = inferBusinessFrameHints([
      {
        stack: 'at aesPrimitive (https://example.test/aes.js:1:1)\n    at assemblePacket (https://example.test/app.js:40:2)\n    at onclick (https://example.test/app.js:90:1)',
        scriptUrl: 'https://example.test/aes.js',
      },
      {
        stack: 'at rsaPrimitive (https://example.test/rsa.js:1:1)\n    at assemblePacket (https://example.test/app.js:52:2)\n    at onclick (https://example.test/app.js:90:1)',
        scriptUrl: 'https://example.test/rsa.js',
      },
      {
        stack: 'at wrapKey (https://example.test/rsa.js:8:1)\n    at assemblePacket (https://example.test/app.js:58:2)\n    at onclick (https://example.test/app.js:90:1)',
        scriptUrl: 'https://example.test/rsa.js',
      },
    ] as never);

    expect(hints[0]).toMatchObject({ functionName: 'assemblePacket', support: 3, averageDepth: 1 });
    expect(hints[1]).toMatchObject({ functionName: 'onclick', support: 3 });
    expect(hints.some((hint) => hint.functionName === 'aesPrimitive')).toBe(false);
  });

  it('does not manufacture a common frame when one stack is unavailable', () => {
    expect(inferBusinessFrameHints([
      { stack: 'at build (https://example.test/app.js:1:1)' },
      { stack: undefined },
    ] as never)).toEqual([]);
  });
});
