import type { BrowserDeepCaptureFrame, BrowserDeepCaptureVariable } from '@/types/models';

export interface CapturedCallableSample {
  body: string;
  label: string;
}

const SCOPE_PRIORITY: Record<string, number> = {
  local: 0,
  block: 1,
  catch: 2,
  closure: 3,
  module: 4,
  script: 5,
  with: 6,
  'wasm-expression-stack': 7,
};

function variableValue(variable: BrowserDeepCaptureVariable): { resolved: boolean; value?: unknown } {
  if (variable.detailTruncated) return { resolved: false };
  const text = variable.detail ?? variable.preview;
  if (variable.type === 'string') return { resolved: true, value: text };
  if (variable.type === 'number') {
    const value = Number(text);
    return Number.isFinite(value) ? { resolved: true, value } : { resolved: false };
  }
  if (variable.type === 'boolean') {
    if (text === 'true') return { resolved: true, value: true };
    if (text === 'false') return { resolved: true, value: false };
    return { resolved: false };
  }
  if (variable.type === 'bigint' && /^-?\d+n?$/.test(text)) {
    return { resolved: true, value: text.replace(/n$/, '') };
  }
  if (variable.subtype === 'null') return { resolved: true, value: null };
  if (variable.type === 'object' && (/^\s*\{/.test(text) || /^\s*\[/.test(text))) {
    try { return { resolved: true, value: JSON.parse(text) }; } catch { return { resolved: false }; }
  }
  return { resolved: false };
}

export function capturedCallableSample(frame?: BrowserDeepCaptureFrame): CapturedCallableSample | undefined {
  const parameterNames = frame?.functionInspection?.parameterNames || [];
  if (!frame || !parameterNames.length) return undefined;
  const scopes = [...frame.scopes].sort((left, right) => (
    (SCOPE_PRIORITY[left.type] ?? 99) - (SCOPE_PRIORITY[right.type] ?? 99)
  ));
  const body: Record<string, unknown> = {};
  for (const parameterName of parameterNames) {
    const variable = scopes.flatMap((scope) => scope.variables).find((item) => item.name === parameterName);
    if (!variable) continue;
    const parsed = variableValue(variable);
    if (parsed.resolved) body[parameterName] = parsed.value;
  }
  if (!Object.keys(body).length) return undefined;
  return {
    body: JSON.stringify(body, null, 2),
    label: `${frame.functionName && frame.functionName !== '(anonymous)' ? frame.functionName : '页面函数'} · 暂停现场`,
  };
}
