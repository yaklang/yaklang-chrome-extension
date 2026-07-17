import { browser } from 'wxt/browser';
import type { UserAgentRule } from '@/types/models';

const RULE_ID_BASE = 20_000;
const MAX_UA_RULES = 5_000;

function domainFilter(domain: string): string {
  const normalized = domain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '');
  return normalized ? `||${normalized}^` : '*';
}

export function buildUserAgentDnrRules(rules: UserAgentRule[]): Browser.declarativeNetRequest.Rule[] {
  const addRules: Browser.declarativeNetRequest.Rule[] = [];
  let nextRuleId = RULE_ID_BASE;
  for (const rule of rules.filter((item) => item.enabled)) {
    const domains = rule.domains.length > 0 ? [...new Set(rule.domains)] : [''];
    for (const domain of domains) {
      if (nextRuleId >= RULE_ID_BASE + MAX_UA_RULES) {
        throw new Error(`User-Agent 动态规则超过 ${MAX_UA_RULES} 条限制`);
      }
      addRules.push({
        id: nextRuleId,
        priority: nextRuleId - RULE_ID_BASE + 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'user-agent', operation: 'set', value: rule.userAgent }],
        },
        condition: {
          urlFilter: domainFilter(domain),
          resourceTypes: [
            'main_frame', 'sub_frame', 'xmlhttprequest', 'script', 'image', 'stylesheet',
            'font', 'media', 'websocket', 'other',
          ],
        },
      });
      nextRuleId += 1;
    }
  }
  return addRules;
}

export async function applyUserAgentRules(rules: UserAgentRule[]): Promise<void> {
  const oldRuleIds = (await browser.declarativeNetRequest.getDynamicRules())
    .map((rule) => rule.id)
    .filter((id) => id >= RULE_ID_BASE && id < RULE_ID_BASE + 10_000);

  await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds: oldRuleIds, addRules: buildUserAgentDnrRules(rules) });
}
