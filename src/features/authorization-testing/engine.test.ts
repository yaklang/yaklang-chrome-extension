import { describe, expect, it } from 'vitest';
import { ExtensionError } from '@/shared/errors';
import { browserAuthorizationWorkspaceRecovery } from './engine';

describe('browser authorization workspace lifecycle recovery', () => {
  it.each([
    ['expired', '自然过期'],
    ['evicted', '容量达到上限'],
    ['engine_instance_changed', '引擎已经重启'],
    ['not_found', '引擎中不存在'],
    ['replaced', '新工作区替换'],
  ] as const)('maps %s to an actionable message', (reason, expected) => {
    const error = new ExtensionError(
      `authorization_workspace_${reason}`,
      'server message',
      {
        reason,
        workspaceId: 'workspace-old',
        engineInstanceId: 'engine-current',
        replacementWorkspaceId: reason === 'replaced' ? 'workspace-new' : undefined,
      },
    );

    expect(browserAuthorizationWorkspaceRecovery(error)).toMatchObject({
      reason,
      message: expect.stringContaining(expected),
    });
  });

  it('does not reinterpret unrelated bridge errors', () => {
    expect(browserAuthorizationWorkspaceRecovery(
      new ExtensionError('bridge_disconnected', 'offline'),
    )).toBeUndefined();
  });
});
