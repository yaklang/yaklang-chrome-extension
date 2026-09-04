import { describe, expect, it } from 'vitest';
import type { BrowserAuthorizationWorkspace } from '../engine';
import {
  authorizationWorkspaceUIReducer,
  authorizationWorkspaceStage,
  INITIAL_AUTHORIZATION_WORKSPACE_UI,
  normalizePersistedAuthorizationWorkspaceUI,
  persistedAuthorizationWorkspaceUI,
} from './workspace-reducer';

function fixtureWorkspace(): BrowserAuthorizationWorkspace {
  return {
    version: 1,
    id: 'workspace-1',
    engineInstanceId: 'engine-1',
    mode: 'horizontal',
    state: 'ready',
    left: {
      deviceId: 'device-a',
      accountLabel: '账号 A',
      origin: 'https://example.test',
      target: { tabId: 11, frameId: 0, documentId: 'document-a' },
      authentication: { status: 'authenticated', cookieCount: 1, storageEntryCount: 0 },
    },
    right: {
      deviceId: 'device-b',
      accountLabel: '账号 B',
      origin: 'https://example.test',
      target: { tabId: 22, frameId: 0, documentId: 'document-b' },
      authentication: { status: 'authenticated', cookieCount: 1, storageEntryCount: 0 },
    },
    proof: {
      level: 'strong',
      sameOrigin: true,
      cookieStoreRelation: 'different',
      accountEvidenceRelation: 'different',
      requestCredentialRelation: 'different',
      refreshCheck: 'passed',
      reasons: ['隔离成立'],
    },
    baselines: {},
    baselinePair: {
      state: 'waiting',
      reasons: ['等待正常请求'],
      resourceCandidates: [],
      operationCandidates: [],
    },
    expiresAt: Date.now() + 60_000,
  };
}

describe('authorization workspace UI reducer', () => {
  it('initializes a renewed workspace and clears evidence tied to the old document', () => {
    const workspace = { id: 'renewed' } as BrowserAuthorizationWorkspace;
    const previous = {
      ...INITIAL_AUTHORIZATION_WORKSPACE_UI,
      candidates: { left: [{ id: 'old-left' }], right: [{ id: 'old-right' }] } as never,
      selected: { left: 'old-left', right: 'old-right' },
      selectedPlanCandidateId: 'old-plan',
    };

    const next = authorizationWorkspaceUIReducer(previous, {
      type: 'workspace.initialize',
      workspace,
    });

    expect(next.workspace).toBe(workspace);
    expect(next.candidates).toEqual({ left: [], right: [] });
    expect(next.selected).toEqual({ left: '', right: '' });
    expect(next.selectedPlanCandidateId).toBe('');
  });

  it('resets workflow evidence without discarding the selected identities', () => {
    const previous = {
      ...INITIAL_AUTHORIZATION_WORKSPACE_UI,
      leftDeviceId: 'device-a',
      rightDeviceId: 'device-b',
      leftTabId: 11,
      rightTabId: 12,
      workspace: { id: 'old' } as BrowserAuthorizationWorkspace,
      capture: { left: { active: true } } as never,
    };
    const next = authorizationWorkspaceUIReducer(previous, { type: 'workspace.reset' });

    expect(next.leftTabId).toBe(11);
    expect(next.rightTabId).toBe(12);
    expect(next.leftDeviceId).toBe('device-a');
    expect(next.rightDeviceId).toBe('device-b');
    expect(next.workspace).toBeUndefined();
    expect(next.capture).toEqual({});
  });

  it('persists only durable workflow state', () => {
    const value = persistedAuthorizationWorkspaceUI({
      ...INITIAL_AUTHORIZATION_WORKSPACE_UI,
      capture: { left: { active: true } } as never,
    });
    expect(value).not.toHaveProperty('capture');
  });

  it('fails closed when a restarted UI session contains a malformed workspace', () => {
    const next = authorizationWorkspaceUIReducer(INITIAL_AUTHORIZATION_WORKSPACE_UI, {
      type: 'hydrate',
      value: {
        mode: 'vertical',
        leftDeviceId: 'device-a',
        rightDeviceId: 'device-b',
        leftTabId: 11,
        rightTabId: 'not-a-tab',
        leftLabel: '低权限账号',
        workspace: { id: 'truncated-before-storage-write' },
        candidates: { left: [null], right: { invalid: true } },
        selected: null,
      },
    });

    expect(next).toMatchObject({
      mode: 'vertical',
      leftTabId: 11,
      leftLabel: '低权限账号',
      workspace: undefined,
      candidates: { left: [], right: [] },
      selected: { left: '', right: '' },
    });
    expect(next.rightTabId).toBeUndefined();
  });

  it('normalizes a valid persisted workflow but drops invalid candidate entries', () => {
    const workspace = {
      ...fixtureWorkspace(),
      createdAt: Date.now(),
    };
    const normalized = normalizePersistedAuthorizationWorkspaceUI({
      mode: 'horizontal',
      leftDeviceId: 'device-a',
      rightDeviceId: 'device-b',
      leftTabId: 11,
      rightTabId: 22,
      leftLabel: '账号 A',
      rightLabel: '账号 B',
      workspace,
      candidates: {
        left: [{
          id: 'left-request',
          method: 'GET',
          url: 'https://example.test/api/profile?id=1',
          path: '/api/profile',
          resourceType: 'xmlhttprequest',
          startedAt: Date.now(),
          eligible: true,
          reasons: [],
        }, { id: 'invalid-url', url: 'javascript:alert(1)' }],
        right: [],
      },
      selected: { left: 'left-request', right: '' },
      selectedPlanCandidateId: '',
      canaryPaths: 'data.owner.id',
    });

    expect(normalized?.workspace?.id).toBe('workspace-1');
    expect(normalized?.candidates?.left).toEqual([
      expect.objectContaining({ id: 'left-request' }),
    ]);
    expect(normalized?.selected?.left).toBe('left-request');
  });

  it('models the complete identity-to-evidence workflow without losing capture state', () => {
    let current = INITIAL_AUTHORIZATION_WORKSPACE_UI;
    expect(authorizationWorkspaceStage(current)).toBe('identity');
    const initial = fixtureWorkspace();
    current = authorizationWorkspaceUIReducer(current, {
      type: 'workspace.initialize',
      workspace: initial,
    });
    current = authorizationWorkspaceUIReducer(current, {
      type: 'capture.replace',
      capture: {
        left: { active: true, count: 1 } as never,
        right: { active: true, count: 1 } as never,
      },
    });
    expect(authorizationWorkspaceStage(current)).toBe('normal-requests');

    const baseline = {
      id: 'baseline',
      networkRequestId: 'request',
      request: {
        method: 'GET',
        url: 'https://example.test/api/profile?id=1',
        path: '/api/profile',
        contentType: 'application/json',
        actionFingerprint: 'fingerprint',
      },
    };
    const bound = {
      ...initial,
      baselines: { left: { ...baseline, id: 'left' }, right: { ...baseline, id: 'right' } },
      baselinePair: {
        state: 'matched' as const,
        reasons: ['同类请求'],
        resourceCandidates: [{
          id: 'resource-id',
          source: 'wire' as const,
          location: 'query' as const,
          path: 'query.id',
          category: 'identifier',
          confidence: 'high' as const,
          requiresLogicalBinding: false,
          reasons: ['A/B 值不同'],
        }],
        operationCandidates: [],
      },
    };
    current = authorizationWorkspaceUIReducer(current, {
      type: 'baselines.loaded',
      candidates: {
        left: [{ id: 'left-request' }] as never,
        right: [{ id: 'right-request' }] as never,
      },
      selected: { left: 'left-request', right: 'right-request' },
    });
    current = authorizationWorkspaceUIReducer(current, {
      type: 'baselines.bound',
      workspace: bound,
      selectedPlanCandidateId: 'resource-id',
    });
    expect(authorizationWorkspaceStage(current)).toBe('plan');

    const planned = {
      ...bound,
      plan: {
        id: 'plan-1',
        mode: 'horizontal' as const,
        candidateId: 'resource-id',
        state: 'ready' as const,
        selector: { source: 'wire' as const, location: 'query' as const, path: 'query.id' },
        cases: [],
        requestBudget: 4,
        requiresDynamicRebuild: false,
        reasons: ['固定四项矩阵'],
      },
    };
    current = authorizationWorkspaceUIReducer(current, {
      type: 'workspace.updated',
      workspace: planned,
    });
    expect(authorizationWorkspaceStage(current)).toBe('execution');

    current = authorizationWorkspaceUIReducer(current, {
      type: 'workspace.updated',
      workspace: {
        ...planned,
        execution: {
          id: 'execution-1',
          state: 'completed',
          verdict: 'protected',
          confidence: 'high',
          requestCount: 4,
          cases: [],
          evidence: [],
          evidenceAvailable: true,
          reasons: ['交叉访问均被拒绝'],
        },
      },
    });
    expect(authorizationWorkspaceStage(current)).toBe('evidence');
    expect(current.capture.left?.active).toBe(true);
    expect(persistedAuthorizationWorkspaceUI(current)).not.toHaveProperty('capture');
  });
});
