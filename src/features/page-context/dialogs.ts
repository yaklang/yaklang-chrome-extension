import { browser } from 'wxt/browser';
import { scriptingTarget } from '@/platform/browser/targets';
import { ExtensionError } from '@/shared/errors';
import type { BrowserTarget, PageDialog } from '@/types/models';

export function installPageDialogCapture(): boolean {
  const key = Symbol.for('com.yaklang.browser.page-dialogs.v1');
  const existing = Reflect.get(globalThis, key) as { messages?: unknown[] } | undefined;
  if (existing?.messages) return false;
  const messages: PageDialog[] = [];
  const original = {
    alert: globalThis.alert,
    confirm: globalThis.confirm,
    prompt: globalThis.prompt,
  };
  const record = (type: PageDialog['type'], value: unknown, decision: PageDialog['decision']): void => {
    if (messages.length >= 20) return;
    let message = '';
    try { message = String(value ?? ''); } catch { message = '[unprintable]'; }
    messages.push({ type, message: message.slice(0, 1_000), decision, timestamp: Date.now() });
  };
  const replacements = {
    alert(value?: unknown) {
      record('alert', value, 'auto_dismissed');
    },
    confirm(value?: unknown) {
      record('confirm', value, 'auto_accepted');
      return true;
    },
    prompt(value?: unknown, defaultValue?: string) {
      record('prompt', value, 'auto_submitted');
      return defaultValue || '';
    },
  };
  try {
    globalThis.alert = replacements.alert;
    globalThis.confirm = replacements.confirm;
    globalThis.prompt = replacements.prompt;
    Reflect.set(globalThis, key, { messages, original, replacements });
    return true;
  } catch {
    globalThis.alert = original.alert;
    globalThis.confirm = original.confirm;
    globalThis.prompt = original.prompt;
    return false;
  }
}

export function restorePageDialogCapture(): PageDialog[] {
  const key = Symbol.for('com.yaklang.browser.page-dialogs.v1');
  const capture = Reflect.get(globalThis, key) as {
    messages?: PageDialog[];
    original?: { alert: typeof globalThis.alert; confirm: typeof globalThis.confirm; prompt: typeof globalThis.prompt };
    replacements?: { alert: typeof globalThis.alert; confirm: typeof globalThis.confirm; prompt: typeof globalThis.prompt };
  } | undefined;
  if (!capture?.original || !capture.replacements) return [];
  if (globalThis.alert === capture.replacements.alert) globalThis.alert = capture.original.alert;
  if (globalThis.confirm === capture.replacements.confirm) globalThis.confirm = capture.original.confirm;
  if (globalThis.prompt === capture.replacements.prompt) globalThis.prompt = capture.original.prompt;
  Reflect.deleteProperty(globalThis, key);
  return Array.isArray(capture.messages) ? capture.messages.slice(0, 20) : [];
}

export async function beginPageDialogCapture(target: BrowserTarget): Promise<boolean> {
  const result = await browser.scripting.executeScript({
    target: scriptingTarget(target),
    world: 'MAIN',
    func: installPageDialogCapture,
  });
  if (result.length !== 1 || typeof result[0].result !== 'boolean') {
    throw new ExtensionError('dialog_capture_unavailable', '无法安全处理页面弹窗，未执行页面操作');
  }
  return result[0].result;
}

export async function endPageDialogCapture(target: BrowserTarget, owned: boolean): Promise<PageDialog[]> {
  if (!owned) return [];
  try {
    const result = await browser.scripting.executeScript({
      target: scriptingTarget(target),
      world: 'MAIN',
      func: restorePageDialogCapture,
    });
    return Array.isArray(result[0]?.result) ? result[0].result as PageDialog[] : [];
  } catch {
    return [];
  }
}
