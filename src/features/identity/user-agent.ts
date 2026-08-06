import { browser } from 'wxt/browser';
import type {
  UserAgentAssignment, UserAgentProfile, UserAgentResolution,
} from '@/types/models';
import { getUserAgentProfiles } from './user-agent-profiles';
import {
  MAX_USER_AGENT_ASSIGNMENTS, normalizeUserAgentHostname, normalizeUserAgentValue,
} from '@/shared/user-agent-state';

const RULE_ID_BASE = 20_000;
const RULE_ID_LIMIT = RULE_ID_BASE + 10_000;

function domainFilter(hostname: string): string {
  return `||${hostname}^`;
}

export function userAgentHostname(url: string): string {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('User-Agent 只能应用到 HTTP(S) 页面');
  return normalizeUserAgentHostname(parsed.hostname);
}

export function validateUserAgent(value: string): string {
  return normalizeUserAgentValue(value);
}

export function resolveUserAgent(
  url: string,
  assignments: UserAgentAssignment[],
  customProfiles: UserAgentProfile[],
  browserDefault = globalThis.navigator?.userAgent || '',
): UserAgentResolution {
  const hostname = userAgentHostname(url);
  const assignment = assignments.find((item) => item.hostname === hostname);
  const profile = assignment
    ? getUserAgentProfiles(customProfiles).find((item) => item.id === assignment.profileId)
    : undefined;
  if (!assignment || !profile) return { hostname, mode: 'default', userAgent: browserDefault };
  return { hostname, mode: 'override', userAgent: profile.userAgent, profile, assignment };
}

export function buildUserAgentDnrRules(
  assignments: UserAgentAssignment[],
  customProfiles: UserAgentProfile[] = [],
): Browser.declarativeNetRequest.Rule[] {
  const profiles = new Map(getUserAgentProfiles(customProfiles).map((profile) => [profile.id, profile]));
  const uniqueAssignments = new Map(assignments.map((assignment) => [assignment.hostname, assignment]));
  const active = [...uniqueAssignments.values()]
    .filter((assignment) => profiles.has(assignment.profileId))
    .sort((left, right) => left.hostname.localeCompare(right.hostname));
  if (active.length > MAX_USER_AGENT_ASSIGNMENTS) throw new Error(`User-Agent 站点绑定超过 ${MAX_USER_AGENT_ASSIGNMENTS} 条限制`);
  return active.map((assignment, index) => {
    const profile = profiles.get(assignment.profileId)!;
    return {
      id: RULE_ID_BASE + index,
      priority: 1_000 + assignment.hostname.split('.').length,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'user-agent', operation: 'set', value: validateUserAgent(profile.userAgent) }],
      },
      condition: {
        urlFilter: domainFilter(assignment.hostname),
        resourceTypes: [
          'main_frame', 'sub_frame', 'xmlhttprequest', 'script', 'image', 'stylesheet',
          'font', 'media', 'websocket', 'other',
        ],
      },
    } satisfies Browser.declarativeNetRequest.Rule;
  });
}

export async function applyUserAgentAssignments(
  assignments: UserAgentAssignment[],
  customProfiles: UserAgentProfile[] = [],
): Promise<void> {
  const oldRuleIds = (await browser.declarativeNetRequest.getDynamicRules())
    .map((rule) => rule.id)
    .filter((id) => id >= RULE_ID_BASE && id < RULE_ID_LIMIT);
  await browser.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: oldRuleIds,
    addRules: buildUserAgentDnrRules(assignments, customProfiles),
  });
}
