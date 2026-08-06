import { describe, expect, it } from 'vitest';
import {
  INITIAL_TRANSFORM_WORKSPACE_STATE,
  transformWorkspaceReducer,
} from './workspace-reducer';

describe('transform workspace reducer', () => {
  it('applies replay fields atomically and invalidates the previous result', () => {
    const next = transformWorkspaceReducer({
      ...INITIAL_TRANSFORM_WORKSPACE_STATE,
      testError: 'old error',
      testResult: { durationMs: 1 } as never,
    }, {
      type: 'replay.apply',
      fields: {
        method: 'PUT',
        url: 'https://example.test/profile',
        headers: '{}',
        body: '{"name":"next"}',
      },
    });

    expect(next).toEqual(expect.objectContaining({
      testMethod: 'PUT',
      testBody: '{"name":"next"}',
      testError: '',
      testResult: undefined,
    }));
  });

  it('switches profile, direction and editor mode as one transition', () => {
    const next = transformWorkspaceReducer(INITIAL_TRANSFORM_WORKSPACE_STATE, {
      type: 'profile.select',
      selectedProfileId: 'profile-1',
      draft: { id: 'profile-1' } as never,
      directionName: 'response',
      editorMode: 'advanced',
    });
    expect(next).toEqual(expect.objectContaining({
      selectedProfileId: 'profile-1',
      directionName: 'response',
      editorMode: 'advanced',
    }));
  });
});
