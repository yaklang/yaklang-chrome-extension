import { browser } from 'wxt/browser';
import { request } from '@/platform/messaging/runtime';

const status = document.getElementById('status');
const fail = (message: string) => {
  if (status) status.textContent = message;
};

async function bootstrap(): Promise<void> {
  const query = new URLSearchParams(location.search);
  const manager = query.get('manager');
  const instanceId = query.get('instanceId') || '';
  const badge = query.get('badge') || '';
  const target = query.get('target') || 'chrome://newtab/';
  if (!['ytray', 'yakit'].includes(manager || '')
    || !/^[A-Za-z0-9-]{1,160}$/.test(instanceId)
    || !/^[A-Z]{1,2}$/.test(badge)) {
    throw new Error('浏览器实例身份参数无效');
  }
  const protocol = new URL(target).protocol;
  if (!['http:', 'https:', 'chrome:'].includes(protocol)
    && target !== 'data:text/html,<title>YTray</title>') {
    throw new Error('浏览器实例目标地址无效');
  }

  await request('bridge.managed-instance.bind', {
    manager: manager as 'ytray' | 'yakit', instanceId, badge,
  });

  const current = await browser.tabs.getCurrent();
  if (!current?.id) {
    location.replace(target);
    return;
  }
  if (query.get('restore') === '1') {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 400));
    const tabs = await browser.tabs.query({ currentWindow: true });
    if (tabs.some((tab) => tab.id !== current.id)) {
      await browser.tabs.remove(current.id);
      return;
    }
  }
  await browser.tabs.update(current.id, { url: target });
}

void bootstrap().catch((error) => fail(error instanceof Error ? error.message : String(error)));
