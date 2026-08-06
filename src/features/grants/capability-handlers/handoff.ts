import { browser } from 'wxt/browser';
import type { HandoffReason } from '@/types/models';
import type { CapabilityDomainHandler } from '../capability-context';
import { allowedTarget } from '../capability-context';
import { activateTab } from '@/platform/browser/targets';
import { getState, updateState } from '@/platform/storage/state';
import { setAgentRuntimeState } from '@/features/agent-runtime/service';
import { ExtensionError } from '@/shared/errors';
import { HANDOFF_CAPABILITY_DOMAIN } from '../capability-domains';

export const handoffCapabilityHandler: CapabilityDomainHandler = {
  ...HANDOFF_CAPABILITY_DOMAIN,
  async handle({ method, input, grant }) {
    if (method === 'browser.handoff.status') {
      const handoff = (await getState()).handoff;
      return handoff?.taskId === grant.taskId ? handoff : { state: 'idle' };
    }
    const resolvedTarget = await allowedTarget(grant, input);
    const grantTarget = grant.targets.find((target) => (
      target.tabId === resolvedTarget.tabId && target.frameId === resolvedTarget.frameId
    ));
    if (!grantTarget) throw new Error('目标标签页不在本次共享会话中');
    const now = Date.now();
    const state = await updateState((current) => {
      if (current.activeGrant?.id !== grant.id || current.activeGrant.expiresAt <= Date.now()) {
        throw new ExtensionError('grant_expired', '浏览器共享会话已经变化，请重新发起请求');
      }
      if (current.handoff?.state === 'waiting_for_user') {
        throw new ExtensionError('handoff_in_progress', '已有人工接管请求正在等待处理');
      }
      return {
        ...current,
        handoff: {
          id: crypto.randomUUID(),
          taskId: grant.taskId,
          target: grantTarget,
          reason: input.reason as HandoffReason,
          message: typeof input.message === 'string' ? input.message : '',
          state: 'waiting_for_user' as const,
          requestedAt: now,
        },
      };
    });
    await activateTab(resolvedTarget.tabId);
    await browser.action.setBadgeBackgroundColor({ color: '#ee7815' });
    await browser.action.setBadgeText({ text: '待确认', tabId: resolvedTarget.tabId });
    await setAgentRuntimeState('waiting_for_human', grant);
    return state.handoff;
  },
};
