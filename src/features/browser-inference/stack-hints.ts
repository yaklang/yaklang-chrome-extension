import type { BrowserBusinessFrameHint, BrowserRecordingEvent } from '@/types/models';

const MAX_STACK_EVENTS = 8;
const MAX_STACK_LINES = 16;
const MAX_HINTS = 8;
const RECORDER_FUNCTION = /^recorded[A-Z]|^pauseForDeepCapture$|^stackInfo$/;

interface ParsedStackFrame {
  functionName: string;
  url?: string;
  depth: number;
}

function normalizeFunctionName(value: string): string {
  const withoutAlias = value.replace(/\s+\[as\s+[^\]]+\]$/, '').replace(/^(?:async\s+|new\s+)/, '').trim();
  const segments = withoutAlias.split('.');
  return (segments.at(-1) || withoutAlias || '(anonymous)').replace(/^Object\./, '');
}

function normalizeScriptUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value.split(/[?#]/, 1)[0].slice(0, 2_048) || undefined;
  }
}

function dependencyFrame(functionName: string, url?: string): boolean {
  const value = `${functionName}\n${url || ''}`.toLowerCase();
  return RECORDER_FUNCTION.test(functionName)
    || value.includes('chrome-extension://')
    || value.includes('page-recorder-main-world')
    || value.includes('/node_modules/')
    || value.includes('crypto-js')
    || value.includes('jsencrypt')
    || value.includes('node-forge')
    || value.includes('sm-crypto')
    || value.includes('webpack/runtime');
}

export function parseRecordingStack(stack?: string, fallbackUrl?: string): ParsedStackFrame[] {
  if (!stack) return [];
  const output: ParsedStackFrame[] = [];
  for (const rawLine of stack.split('\n').slice(0, MAX_STACK_LINES)) {
    const line = rawLine.trim();
    if (!line) continue;
    const location = line.match(/((?:(?:https?|file|blob|webpack|chrome-extension):\/\/|\/)[^\s)]+):(\d+):(\d+)\)?$/);
    if (!location) continue;
    const url = normalizeScriptUrl(location[1] || fallbackUrl);
    let prefix = location ? line.slice(0, location.index).trim() : line;
    prefix = prefix.replace(/^at\s+/, '').replace(/\($/, '').replace(/@$/, '').trim();
    const functionName = normalizeFunctionName(prefix || '(anonymous)');
    if (dependencyFrame(functionName, url)) continue;
    output.push({ functionName, url, depth: output.length });
  }
  return output;
}

export function inferBusinessFrameHints(
  events: Array<Pick<BrowserRecordingEvent, 'stack' | 'scriptUrl'>>,
): BrowserBusinessFrameHint[] {
  const bounded = events.slice(0, MAX_STACK_EVENTS);
  if (!bounded.length) return [];
  const parsed = bounded.map((event) => parseRecordingStack(event.stack, event.scriptUrl));
  if (parsed.some((frames) => !frames.length)) return [];
  const evidence = new Map<string, { functionName: string; url?: string; depths: number[]; events: Set<number> }>();
  parsed.forEach((frames, eventIndex) => {
    const seen = new Set<string>();
    for (const frame of frames) {
      const key = `${frame.functionName}\n${frame.url || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const current = evidence.get(key) || {
        functionName: frame.functionName,
        url: frame.url,
        depths: [],
        events: new Set<number>(),
      };
      current.depths.push(frame.depth);
      current.events.add(eventIndex);
      evidence.set(key, current);
    }
  });
  const requiredSupport = bounded.length;
  return [...evidence.values()]
    .filter((item) => item.events.size === requiredSupport)
    .map((item) => ({
      functionName: item.functionName.slice(0, 240),
      url: item.url?.slice(0, 4_096),
      support: item.events.size,
      averageDepth: item.depths.reduce((sum, depth) => sum + depth, 0) / Math.max(1, item.depths.length),
    }))
    .sort((left, right) => left.averageDepth - right.averageDepth
      || left.functionName.localeCompare(right.functionName)
      || (left.url || '').localeCompare(right.url || ''))
    .slice(0, MAX_HINTS);
}
