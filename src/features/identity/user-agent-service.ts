import type {
  ExtensionState, UserAgentProfile, UserAgentProfileInput,
} from '@/types/models';
import { getState, updateState } from '@/platform/storage/state';
import { ExtensionError } from '@/shared/errors';
import {
  assertUserAgentState, MAX_CUSTOM_USER_AGENT_PROFILES, type UserAgentStateSlice,
  userAgentStateFingerprint,
} from '@/shared/user-agent-state';
import { applyUserAgentAssignments, userAgentHostname, validateUserAgent } from './user-agent';
import { BUILTIN_USER_AGENT_PROFILES, getUserAgentProfiles } from './user-agent-profiles';

let userAgentMutationQueue: Promise<void> = Promise.resolve();

function enqueueUserAgentMutation<T>(operation: () => Promise<T>): Promise<T> {
  const next = userAgentMutationQueue.then(operation);
  userAgentMutationQueue = next.then(() => undefined, () => undefined);
  return next;
}

function stateSlice(state: ExtensionState): UserAgentStateSlice {
  return {
    customUserAgentProfiles: state.customUserAgentProfiles,
    userAgentAssignments: state.userAgentAssignments,
  };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_024);
}

async function reconcileDnrWithAuthoritativeState(cause: unknown): Promise<never> {
  try {
    const authoritative = await getState();
    await applyUserAgentAssignments(
      authoritative.userAgentAssignments,
      authoritative.customUserAgentProfiles,
    );
  } catch (restoreError) {
    throw new ExtensionError(
      'ua_consistency_restore_failed',
      `User-Agent 设置提交失败，且无法恢复网络规则一致性: ${errorMessage(restoreError)}`,
    );
  }
  if (cause instanceof ExtensionError) throw cause;
  throw new ExtensionError('ua_state_commit_failed', `User-Agent 网络规则已恢复，但设置未能提交: ${errorMessage(cause)}`);
}

function mutateUserAgentState(
  updater: (current: ExtensionState) => UserAgentStateSlice,
): Promise<ExtensionState> {
  return enqueueUserAgentMutation(async () => {
    const before = await getState();
    const next = updater(before);
    assertUserAgentState(next);
    if (userAgentStateFingerprint(stateSlice(before)) === userAgentStateFingerprint(next)) return before;

    try {
      await applyUserAgentAssignments(next.userAgentAssignments, next.customUserAgentProfiles);
    } catch (error) {
      throw new ExtensionError('ua_rules_apply_failed', `无法应用 User-Agent 网络规则: ${errorMessage(error)}`);
    }

    try {
      return await updateState((current) => {
        if (userAgentStateFingerprint(stateSlice(current)) !== userAgentStateFingerprint(stateSlice(before))) {
          throw new ExtensionError('ua_state_changed', 'User-Agent 设置已被另一个操作更新，请重试');
        }
        return {
          ...current,
          customUserAgentProfiles: next.customUserAgentProfiles,
          userAgentAssignments: next.userAgentAssignments,
        };
      });
    } catch (error) {
      return reconcileDnrWithAuthoritativeState(error);
    }
  });
}

export function reconcileUserAgentRuntime(): Promise<ExtensionState> {
  return enqueueUserAgentMutation(async () => {
    const state = await getState();
    assertUserAgentState(stateSlice(state));
    try {
      await applyUserAgentAssignments(state.userAgentAssignments, state.customUserAgentProfiles);
      return state;
    } catch (error) {
      throw new ExtensionError('ua_rules_apply_failed', `无法恢复 User-Agent 网络规则: ${errorMessage(error)}`);
    }
  });
}

export async function saveUserAgentProfile(input: UserAgentProfileInput): Promise<{
  profile: UserAgentProfile;
  state: ExtensionState;
}> {
  const profile: UserAgentProfile = {
    id: input.id || crypto.randomUUID(),
    name: input.name.trim(),
    userAgent: validateUserAgent(input.userAgent),
    category: 'custom',
    builtin: false,
  };
  if (BUILTIN_USER_AGENT_PROFILES.some((item) => item.id === profile.id)) {
    throw new Error('不能覆盖内置 User-Agent 预设');
  }
  const state = await mutateUserAgentState((current) => {
    const exists = current.customUserAgentProfiles.some((item) => item.id === profile.id);
    if (!exists && current.customUserAgentProfiles.length >= MAX_CUSTOM_USER_AGENT_PROFILES) {
      throw new Error(`自定义 User-Agent 预设不能超过 ${MAX_CUSTOM_USER_AGENT_PROFILES} 个`);
    }
    return {
      customUserAgentProfiles: [
        ...current.customUserAgentProfiles.filter((item) => item.id !== profile.id),
        profile,
      ],
      userAgentAssignments: current.userAgentAssignments,
    };
  });
  return { profile, state };
}

export function deleteUserAgentProfile(id: string): Promise<ExtensionState> {
  if (BUILTIN_USER_AGENT_PROFILES.some((profile) => profile.id === id)) {
    throw new Error('不能删除内置 User-Agent 预设');
  }
  return mutateUserAgentState((current) => ({
    customUserAgentProfiles: current.customUserAgentProfiles.filter((item) => item.id !== id),
    userAgentAssignments: current.userAgentAssignments.filter((item) => item.profileId !== id),
  }));
}

export function applyUserAgentToSite(url: string, profileId: string): Promise<ExtensionState> {
  const hostname = userAgentHostname(url);
  const now = Date.now();
  return mutateUserAgentState((current) => {
    const profile = getUserAgentProfiles(current.customUserAgentProfiles).find((item) => item.id === profileId);
    if (!profile) throw new Error('User-Agent 预设不存在');
    const existing = current.userAgentAssignments.find((item) => item.hostname === hostname);
    return {
      customUserAgentProfiles: current.customUserAgentProfiles,
      userAgentAssignments: [
        ...current.userAgentAssignments.filter((item) => item.hostname !== hostname),
        {
          id: existing?.id || crypto.randomUUID(),
          hostname,
          profileId: profile.id,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        },
      ],
    };
  });
}

export function resetUserAgentForSite(url: string): Promise<ExtensionState> {
  const hostname = userAgentHostname(url);
  return mutateUserAgentState((current) => ({
    customUserAgentProfiles: current.customUserAgentProfiles,
    userAgentAssignments: current.userAgentAssignments.filter((item) => item.hostname !== hostname),
  }));
}
