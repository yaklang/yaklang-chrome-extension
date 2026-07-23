import type {
  NormalizedProxyRule, ProxyCondition, ProxyRuleParseDiagnostics, ProxyRuleSourceFormat,
} from '@/types/models';

export interface ParsedProxyRuleSource {
  rules: NormalizedProxyRule[];
  diagnostics: ProxyRuleParseDiagnostics;
  decodedText: string;
}

interface ParseContext {
  sourceId: string;
  rules: NormalizedProxyRule[];
  total: number;
  ignored: number;
  invalid: number;
  warnings: string[];
  seen: Set<string>;
}

const HOST_PATTERN = /^(?:\*\.)?(?:[a-z0-9_-]+\.)*[a-z0-9_-]+\.?$/i;

function warning(context: ParseContext, message: string): void {
  if (context.warnings.length < 20) context.warnings.push(message);
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
}

function validRegex(value: string): boolean {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

function addRule(
  context: ParseContext,
  raw: string,
  condition: ProxyCondition | undefined,
  exception = false,
  resultProfileName?: string,
): void {
  if (!condition || !condition.value.trim()) {
    context.invalid += 1;
    warning(context, `无法解析：${raw.slice(0, 120)}`);
    return;
  }
  const normalized: ProxyCondition = {
    type: condition.type,
    value: condition.type === 'host_exact' || condition.type === 'host_suffix'
      ? normalizeHost(condition.value)
      : condition.type === 'host_wildcard'
        ? condition.value.trim().toLowerCase().replace(/\.$/, '')
        : condition.value.trim(),
  };
  if (!normalized.value || (normalized.type === 'host_exact' || normalized.type === 'host_suffix') && !HOST_PATTERN.test(normalized.value)) {
    context.invalid += 1;
    warning(context, `无效的域名条件：${raw.slice(0, 120)}`);
    return;
  }
  if ((normalized.type === 'host_regex' || normalized.type === 'url_regex') && !validRegex(normalized.value)) {
    context.invalid += 1;
    warning(context, `无效的正则表达式：${raw.slice(0, 120)}`);
    return;
  }
  const key = `${exception ? '!' : ''}${normalized.type}:${normalized.value}:${resultProfileName || ''}`;
  if (context.seen.has(key)) {
    context.ignored += 1;
    return;
  }
  context.seen.add(key);
  context.rules.push({
    sourceId: context.sourceId,
    ordinal: context.rules.length,
    condition: normalized,
    exception,
    raw,
    ...(resultProfileName ? { resultProfileName } : {}),
  });
}

function decodeAutoProxyText(input: string): string {
  const text = input.trim().replace(/^\uFEFF/, '');
  if (text.startsWith('[AutoProxy')) return text;
  const compact = text.replace(/\s+/g, '');
  if (!compact.startsWith('W0F1dG9Qcm94')) return text;
  try {
    const binary = atob(compact);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
    return decoded.startsWith('[AutoProxy') ? decoded : text;
  } catch {
    return text;
  }
}

function detectFormat(text: string): Exclude<ProxyRuleSourceFormat, 'auto'> {
  const trimmed = text.trim();
  if (trimmed.startsWith('[AutoProxy') || trimmed.replace(/\s+/g, '').startsWith('W0F1dG9Qcm94')) return 'autoproxy';
  if (/^\[SwitchyOmega Conditions/m.test(trimmed) || /^@(with|note)\b/im.test(trimmed)) return 'switchyomega';
  return 'hosts';
}

function autoProxyCondition(value: string): ProxyCondition | undefined {
  let pattern = value.trim();
  if (!pattern) return undefined;
  if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2) {
    return { type: 'url_regex', value: pattern.slice(1, -1) };
  }
  const optionIndex = pattern.indexOf('$');
  if (optionIndex >= 0) pattern = pattern.slice(0, optionIndex);
  if (pattern.includes('##') || pattern.includes('#@#') || pattern.includes('#?#') || pattern.includes('#$#')) return undefined;
  if (pattern.startsWith('||')) {
    const host = pattern.slice(2).split(/[\^/*]/, 1)[0];
    return host ? { type: 'host_suffix', value: host } : undefined;
  }
  if (pattern.startsWith('|')) {
    pattern = pattern.slice(1).replace(/\|$/, '');
    return pattern ? { type: 'url_prefix', value: pattern } : undefined;
  }
  if (!pattern.includes('*') && !pattern.includes('^')) return { type: 'keyword', value: pattern };
  return { type: 'url_wildcard', value: pattern.replaceAll('^', '*') };
}

function parseAutoProxy(text: string, context: ParseContext): void {
  const exclusive: Array<{ raw: string; condition: ProxyCondition }> = [];
  const regular: Array<{ raw: string; condition: ProxyCondition }> = [];
  for (const sourceLine of text.split(/\r?\n|\r/)) {
    let line = sourceLine.trim();
    if (!line || line.startsWith('!') || line.startsWith('[')) continue;
    context.total += 1;
    const exception = line.startsWith('@@');
    if (exception) line = line.slice(2);
    const condition = autoProxyCondition(line);
    if (!condition) {
      context.ignored += 1;
      continue;
    }
    (exception ? exclusive : regular).push({ raw: sourceLine.trim(), condition });
  }
  for (const item of exclusive) addRule(context, item.raw, item.condition, true);
  for (const item of regular) addRule(context, item.raw, item.condition, false);
}

const SWITCHY_TYPES: Record<string, ProxyCondition['type']> = {
  '': 'host_wildcard', h: 'host_wildcard', w: 'host_wildcard', hw: 'host_wildcard', host: 'host_wildcard',
  wildcard: 'host_wildcard', hostwildcard: 'host_wildcard',
  r: 'host_regex', hr: 'host_regex', regex: 'host_regex', hostregex: 'host_regex',
  u: 'url_wildcard', uw: 'url_wildcard', url: 'url_wildcard', urlwildcard: 'url_wildcard',
  ur: 'url_regex', uregex: 'url_regex', urlregex: 'url_regex',
  k: 'keyword', kw: 'keyword', keyword: 'keyword',
};

function switchyCondition(value: string): ProxyCondition | undefined {
  const typed = value.match(/^([A-Za-z]+):\s*(.*)$/);
  const typeKey = typed?.[1].toLowerCase() || '';
  const pattern = (typed?.[2] ?? value).trim();
  if (pattern === '*') return undefined;
  const type = SWITCHY_TYPES[typeKey];
  if (!type) return undefined;
  if (type === 'host_wildcard' && !pattern.includes('*') && !pattern.includes('?')) return { type: 'host_suffix', value: pattern };
  return { type, value: pattern };
}

function parseSwitchyOmega(text: string, context: ParseContext): void {
  let withResult = false;
  for (const sourceLine of text.split(/\r?\n|\r/)) {
    let line = sourceLine.trim();
    if (!line || line.startsWith('[') || line.startsWith(';') || line.startsWith('#')) continue;
    if (line.startsWith('@')) {
      if (/^@with\s+results?$/i.test(line)) withResult = true;
      continue;
    }
    context.total += 1;
    let exception = false;
    if (line.startsWith('!')) {
      exception = true;
      line = line.slice(1).trim();
    }
    let resultProfileName: string | undefined;
    if (withResult) {
      const resultIndex = line.lastIndexOf(' +');
      if (resultIndex >= 0) {
        resultProfileName = line.slice(resultIndex + 2).trim();
        line = line.slice(0, resultIndex).trim();
      }
      if (line === '*') {
        context.ignored += 1;
        continue;
      }
    }
    const condition = switchyCondition(line);
    if (!condition) {
      context.invalid += 1;
      warning(context, `不支持的 SwitchyOmega 条件：${sourceLine.slice(0, 120)}`);
      continue;
    }
    addRule(context, sourceLine.trim(), condition, exception, resultProfileName);
  }
}

function parseHosts(text: string, context: ParseContext): void {
  for (const sourceLine of text.split(/\r?\n|\r/)) {
    const line = sourceLine.replace(/\s*[#!;].*$/, '').trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(fields[0])
      && fields[0].split('.').every((part) => Number(part) <= 255);
    const ipv6 = fields[0].includes(':') && /^[0-9a-f:]+$/i.test(fields[0]);
    const candidates = fields.length === 1 ? fields : ipv4 || ipv6 ? fields.slice(1) : [];
    context.total += Math.max(1, candidates.length);
    if (candidates.length === 0) {
      context.invalid += 1;
      warning(context, `无效的域名行：${sourceLine.slice(0, 120)}`);
      continue;
    }
    for (const candidate of candidates) {
      if (!HOST_PATTERN.test(candidate)) {
        context.invalid += 1;
        warning(context, `无效的域名行：${sourceLine.slice(0, 120)}`);
        continue;
      }
      addRule(context, sourceLine.trim(), { type: 'host_suffix', value: candidate });
    }
  }
}

export function parseProxyRuleSource(
  input: string,
  requestedFormat: ProxyRuleSourceFormat,
  sourceId: string,
): ParsedProxyRuleSource {
  const detectedFormat = requestedFormat === 'auto' ? detectFormat(input) : requestedFormat;
  const decodedText = detectedFormat === 'autoproxy' ? decodeAutoProxyText(input) : input.replace(/^\uFEFF/, '');
  const context: ParseContext = {
    sourceId,
    rules: [],
    total: 0,
    ignored: 0,
    invalid: 0,
    warnings: [],
    seen: new Set(),
  };
  if (detectedFormat === 'autoproxy') parseAutoProxy(decodedText, context);
  else if (detectedFormat === 'switchyomega') parseSwitchyOmega(decodedText, context);
  else parseHosts(decodedText, context);
  context.rules.forEach((rule, ordinal) => { rule.ordinal = ordinal; });
  return {
    rules: context.rules,
    decodedText,
    diagnostics: {
      detectedFormat,
      total: context.total,
      supported: context.rules.length,
      ignored: context.ignored,
      invalid: context.invalid,
      warnings: context.warnings,
    },
  };
}
