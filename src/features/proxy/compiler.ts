import type {
  NormalizedProxyRule, ProxyCondition, ProxyProfile, ProxyRouteTrace, ProxyRoutingSettings,
  ProxyRule, ProxyRulePreview, ProxyRuleSource,
} from '@/types/models';
import { hashText } from './hash';

const MAX_PAC_BYTES = 4 * 1024 * 1024;
const LARGE_PAC_BYTES = 1024 * 1024;

export interface ProxyCompilationInput {
  manualRules: ProxyRule[];
  sources: ProxyRuleSource[];
  sourceRules: Map<string, NormalizedProxyRule[]>;
  profiles: ProxyProfile[];
  routing: ProxyRoutingSettings;
}

export interface CompiledProxyArtifact {
  revision: string;
  pacScript: string;
  compiledBytes: number;
  manualRuleCount: number;
  sourceRuleCount: number;
  warnings: string[];
}

type TrieNode = { $?: number; [key: string]: TrieNode | number | undefined };

function json(value: unknown): string {
  return JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

export function sortedProxyRules(rules: ProxyRule[]): ProxyRule[] {
  return [...rules].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

export function sortedProxyRuleSources(sources: ProxyRuleSource[]): ProxyRuleSource[] {
  return [...sources].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

export function profileToPac(profile: ProxyProfile, failMode: ProxyRoutingSettings['failMode'] = 'closed'): string {
  if (profile.kind === 'direct') return 'DIRECT';
  if (profile.kind === 'system' || profile.kind === 'pac_script') throw new Error(`${profile.name} 不能作为自动切换出口`);
  const host = profile.host || '127.0.0.1';
  const port = profile.port || 8083;
  const proxy = profile.scheme === 'socks4' ? `SOCKS ${host}:${port}`
    : profile.scheme === 'socks5' ? `SOCKS5 ${host}:${port}`
      : profile.scheme === 'https' ? `HTTPS ${host}:${port}` : `PROXY ${host}:${port}`;
  return failMode === 'open' ? `${proxy}; DIRECT` : proxy;
}

function wildcardRegex(pattern: string): string {
  return `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`;
}

function addTrieCondition(trie: TrieNode, condition: ProxyCondition): boolean {
  if (condition.type !== 'host_exact' && condition.type !== 'host_suffix') return false;
  const labels = condition.value.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean).reverse();
  if (labels.length === 0) return false;
  let node = trie;
  for (const label of labels) {
    const key = `:${label}`;
    const existing = node[key];
    if (!existing || typeof existing === 'number') node[key] = {};
    node = node[key] as TrieNode;
  }
  node.$ = (node.$ || 0) | (condition.type === 'host_suffix' ? 1 : 2);
  return true;
}

interface ConditionCompiler {
  regexps: Array<{ value: string; flags: string }>;
}

function compileCondition(condition: ProxyCondition, compiler: ConditionCompiler): string {
  const value = condition.value.trim();
  if (condition.type === 'host_exact') return `host===${json(value.toLowerCase())}`;
  if (condition.type === 'host_suffix') {
    const domain = value.toLowerCase();
    return `(host===${json(domain)}||dnsDomainIs(host,${json(`.${domain}`)}))`;
  }
  if (condition.type === 'url_prefix') return `url.indexOf(${json(value)})===0`;
  if (condition.type === 'keyword') return `url.indexOf(${json(value)})>=0`;
  const expression = condition.type === 'host_wildcard' || condition.type === 'url_wildcard'
    ? wildcardRegex(value)
    : value;
  try {
    new RegExp(expression, 'i');
  } catch {
    throw new Error(`无效的${condition.type.startsWith('host_') ? '域名' : 'URL'}正则表达式：${value.slice(0, 160)}`);
  }
  const index = compiler.regexps.push({ value: expression, flags: 'i' }) - 1;
  return `__rx[${index}].test(${condition.type.startsWith('host_') ? 'host' : 'url'})`;
}

function resolveProfile(
  profileIdOrName: string | undefined,
  profiles: ProxyProfile[],
  fallbackId: string,
): ProxyProfile {
  const profile = profiles.find((item) => item.id === profileIdOrName || item.name === profileIdOrName)
    || profiles.find((item) => item.id === fallbackId)
    || profiles.find((item) => item.id === 'direct');
  if (!profile || !['direct', 'fixed_servers'].includes(profile.kind)) throw new Error(`自动切换出口不存在：${profileIdOrName || fallbackId}`);
  return profile;
}

function resolveNamedSourceProfile(name: string, source: ProxyRuleSource, profiles: ProxyProfile[]): ProxyProfile {
  const profile = profiles.find((item) => item.id === name || item.name === name);
  if (!profile || !['direct', 'fixed_servers'].includes(profile.kind)) {
    throw new Error(`规则源“${source.name}”引用了未知或不可路由的出口：${name}`);
  }
  return profile;
}

export function proxyCompilationRevision(input: ProxyCompilationInput): string {
  return hashText(JSON.stringify({
    manual: sortedProxyRules(input.manualRules).map((rule) => [
      rule.id, rule.enabled, rule.order, rule.condition.type, rule.condition.value, rule.proxyProfileId, rule.updatedAt,
    ]),
    sources: sortedProxyRuleSources(input.sources).map((source) => [
      source.id, source.enabled, source.order, source.revision, source.matchProfileId, source.bypassProfileId,
    ]),
    profiles: input.profiles.map((profile) => [
      profile.id, profile.kind, profile.scheme, profile.host, profile.port, profile.bypass, profile.authEnabled,
    ]),
    routing: input.routing,
  }));
}

function sourceBlock(
  source: ProxyRuleSource,
  rules: NormalizedProxyRule[],
  input: ProxyCompilationInput,
  compiler: ConditionCompiler,
  tries: TrieNode[],
): string[] {
  if (rules.length === 0) return [];
  const hasCustomResults = rules.some((rule) => rule.resultProfileName);
  if (hasCustomResults) {
    return rules.map((rule) => {
      const target = rule.exception
        ? resolveProfile(source.bypassProfileId, input.profiles, input.routing.defaultProfileId)
        : rule.resultProfileName
          ? resolveNamedSourceProfile(rule.resultProfileName, source, input.profiles)
          : resolveProfile(source.matchProfileId, input.profiles, source.matchProfileId);
      return `if(${compileCondition(rule.condition, compiler)})return ${json(profileToPac(target, input.routing.failMode))};`;
    });
  }

  const blocks: string[] = [];
  for (const exception of [true, false]) {
    const selected = rules.filter((rule) => rule.exception === exception);
    if (selected.length === 0) continue;
    const trie: TrieNode = {};
    const slow: string[] = [];
    for (const rule of selected) {
      if (!addTrieCondition(trie, rule.condition)) slow.push(compileCondition(rule.condition, compiler));
    }
    const conditions: string[] = [];
    if (Object.keys(trie).length > 0) {
      const trieIndex = tries.push(trie) - 1;
      conditions.push(`__matchHost(host,__tries[${trieIndex}])`);
    }
    conditions.push(...slow);
    if (conditions.length === 0) continue;
    const target = resolveProfile(
      exception ? source.bypassProfileId : source.matchProfileId,
      input.profiles,
      input.routing.defaultProfileId,
    );
    const result = json(profileToPac(target, input.routing.failMode));
    const chunkSize = 64;
    for (let index = 0; index < conditions.length; index += chunkSize) {
      blocks.push(`if(${conditions.slice(index, index + chunkSize).join('||')})return ${result};`);
    }
  }
  return blocks;
}

export function compileProxyRules(input: ProxyCompilationInput): CompiledProxyArtifact {
  const compiler: ConditionCompiler = { regexps: [] };
  const tries: TrieNode[] = [];
  const body: string[] = [];
  const enabledManualRules = sortedProxyRules(input.manualRules).filter((rule) => rule.enabled);
  for (const rule of enabledManualRules) {
    const target = resolveProfile(rule.proxyProfileId, input.profiles, input.routing.defaultProfileId);
    body.push(`if(${compileCondition(rule.condition, compiler)})return ${json(profileToPac(target, input.routing.failMode))};`);
  }

  let sourceRuleCount = 0;
  for (const source of sortedProxyRuleSources(input.sources).filter((item) => item.enabled && item.revision)) {
    const rules = input.sourceRules.get(source.id) || [];
    sourceRuleCount += rules.length;
    body.push(...sourceBlock(source, rules, input, compiler, tries));
  }

  const fallback = resolveProfile(input.routing.defaultProfileId, input.profiles, 'direct');
  const regexps = `[${compiler.regexps.map((item) => `new RegExp(${json(item.value)},${json(item.flags)})`).join(',')}]`;
  const pacScript = `var __rx=${regexps},__tries=${json(tries)};function __matchHost(host,trie){var parts=host.toLowerCase().split('.'),node=trie;for(var i=parts.length-1;i>=0;i--){node=node[':'+parts[i]];if(!node)return false;if((node.$||0)&1)return true}return !!((node.$||0)&2)}function FindProxyForURL(url,host){${body.join('')}return ${json(profileToPac(fallback, input.routing.failMode))};}`;
  const compiledBytes = new TextEncoder().encode(pacScript).byteLength;
  if (compiledBytes > MAX_PAC_BYTES) {
    throw new Error(`编译后的 PAC 为 ${(compiledBytes / 1024 / 1024).toFixed(2)} MB，超过 4 MB 安全上限；请停用重叠规则源或拆分自动切换方案`);
  }
  const warnings: string[] = [];
  if (compiledBytes > LARGE_PAC_BYTES) warnings.push(`PAC 已达到 ${(compiledBytes / 1024 / 1024).toFixed(2)} MB，请关注首次应用耗时`);
  if (compiler.regexps.length > 1_000) warnings.push(`${compiler.regexps.length} 条规则进入正则慢速路径`);
  return {
    revision: proxyCompilationRevision(input),
    pacScript,
    compiledBytes,
    manualRuleCount: enabledManualRules.length,
    sourceRuleCount,
    warnings,
  };
}

export function proxyConditionMatches(condition: ProxyCondition, rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    const value = condition.value.trim();
    if (condition.type === 'host_exact') return host === value.toLowerCase();
    if (condition.type === 'host_suffix') {
      const domain = value.toLowerCase();
      return host === domain || host.endsWith(`.${domain}`);
    }
    if (condition.type === 'url_prefix') return rawUrl.startsWith(value);
    if (condition.type === 'keyword') return rawUrl.includes(value);
    const regexp = new RegExp(
      condition.type === 'host_wildcard' || condition.type === 'url_wildcard' ? wildcardRegex(value) : value,
      'i',
    );
    return regexp.test(condition.type.startsWith('host_') ? host : rawUrl);
  } catch {
    return false;
  }
}

export function previewProxyRules(url: string, input: ProxyCompilationInput): ProxyRulePreview {
  const parsed = new URL(url);
  const trace: ProxyRouteTrace[] = [];
  for (const rule of sortedProxyRules(input.manualRules).filter((item) => item.enabled)) {
    const matched = proxyConditionMatches(rule.condition, url);
    if (trace.length < 12) trace.push({
      kind: 'manual', name: rule.name, condition: `${rule.condition.type}: ${rule.condition.value}`,
      matched, profileId: rule.proxyProfileId,
    });
    if (matched) {
      const profile = resolveProfile(rule.proxyProfileId, input.profiles, input.routing.defaultProfileId);
      return {
        url, hostname: parsed.hostname, effectiveProfileId: profile.id, effectiveProxy: profileToPac(profile, input.routing.failMode),
        matchedKind: 'manual', matchedName: rule.name, matchedCondition: rule.condition.value, matchedRuleId: rule.id, trace,
      };
    }
  }
  for (const source of sortedProxyRuleSources(input.sources).filter((item) => item.enabled && item.revision)) {
    const rules = input.sourceRules.get(source.id) || [];
    const hasCustomResults = rules.some((rule) => rule.resultProfileName);
    const previewOrder = hasCustomResults
      ? rules
      : [...rules.filter((rule) => rule.exception), ...rules.filter((rule) => !rule.exception)];
    const matchedRule = previewOrder.find((rule) => proxyConditionMatches(rule.condition, url));
    trace.push({
      kind: 'source', name: source.name, condition: matchedRule?.condition.value, matched: Boolean(matchedRule),
      profileId: matchedRule?.exception ? source.bypassProfileId : source.matchProfileId,
    });
    if (matchedRule) {
      const profile = resolveProfile(
        matchedRule.exception ? source.bypassProfileId : source.matchProfileId,
        input.profiles, input.routing.defaultProfileId,
      );
      const effectiveProfile = !matchedRule.exception && matchedRule.resultProfileName
        ? resolveNamedSourceProfile(matchedRule.resultProfileName, source, input.profiles)
        : profile;
      return {
        url, hostname: parsed.hostname, effectiveProfileId: effectiveProfile.id, effectiveProxy: profileToPac(effectiveProfile, input.routing.failMode),
        matchedKind: 'source', matchedName: source.name, matchedCondition: matchedRule.raw, matchedSourceId: source.id, trace,
      };
    }
  }
  const profile = resolveProfile(input.routing.defaultProfileId, input.profiles, 'direct');
  trace.push({ kind: 'default', name: '默认出口', matched: true, profileId: profile.id });
  return {
    url, hostname: parsed.hostname, effectiveProfileId: profile.id, effectiveProxy: profileToPac(profile, input.routing.failMode),
    matchedKind: 'default', matchedName: '默认出口', trace,
  };
}
