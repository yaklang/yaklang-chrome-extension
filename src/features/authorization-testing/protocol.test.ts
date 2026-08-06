import { describe, expect, it } from 'vitest';
import { ExtensionError } from '@/shared/errors';
import { normalizeBrowserAuthorizationTaskResult } from './protocol';

function context(side: 'left' | 'right') {
  return {
    side,
    target: {tabId: side === 'left' ? 1 : 2, frameId: 0, documentId: `document-${side}`},
    authentication: {
      status: 'authenticated',
      cookieCount: 1,
      storageEntryCount: 0,
      authCookieNames: null,
      authStorageKeys: null,
    },
  };
}

function workspace(extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: 'workspace-1',
    engineInstanceId: 'engine-1',
    mode: 'horizontal',
    state: 'ready',
    left: context('left'),
    right: context('right'),
    proof: {level: 'strong', reasons: null},
    baselines: {},
    baselinePair: {state: 'waiting', reasons: null, resourceCandidates: null, operationCandidates: null},
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...extra,
  };
}

describe('authorization task response protocol', () => {
  it('normalizes nullable collections before the workspace reaches React', () => {
    const result = normalizeBrowserAuthorizationTaskResult<ReturnType<typeof workspace>>(
      'authorization.workspace.inspect',
      workspace(),
    );
    expect(result.baselinePair.resourceCandidates).toEqual([]);
    expect(result.proof.reasons).toEqual([]);
    expect(result.left.authentication.authCookieNames).toEqual([]);
  });

  it('normalizes a null candidate list and candidate reasons', () => {
    expect(normalizeBrowserAuthorizationTaskResult(
      'authorization.baseline.candidates',
      null,
    )).toEqual([]);
    expect(normalizeBrowserAuthorizationTaskResult(
      'authorization.baseline.candidates',
      [{id: 'candidate-1', reasons: null}],
    )).toEqual([{id: 'candidate-1', reasons: []}]);
  });

  it('rejects old versions, extra fields, and wrong collection types with field paths', () => {
    expect(() => normalizeBrowserAuthorizationTaskResult(
      'authorization.workspace.inspect',
      workspace({version: 0}),
    )).toThrow('$.version');
    expect(() => normalizeBrowserAuthorizationTaskResult(
      'authorization.workspace.inspect',
      workspace({legacy: true}),
    )).toThrow('$.legacy');
    expect(() => normalizeBrowserAuthorizationTaskResult(
      'authorization.workspace.inspect',
      workspace({baselinePair: {state: 'waiting', resourceCandidates: {}, operationCandidates: []}}),
    )).toThrow('$.baselinePair.resourceCandidates');
  });

  it('uses a stable schema mismatch code', () => {
    try {
      normalizeBrowserAuthorizationTaskResult('authorization.workspace.inspect', null);
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ExtensionError);
      expect((error as ExtensionError).code).toBe('authorization_protocol_schema_mismatch');
    }
  });
});
