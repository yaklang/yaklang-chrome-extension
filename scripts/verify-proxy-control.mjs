import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';
import { resolveChromiumPath } from './resolve-chromium.mjs';

// Uses an isolated profile; never changes the user's browser or system proxy.
const profile = await mkdtemp(join(tmpdir(), 'yakit-proxy-control-'));
const extension = resolve('.output/chrome-mv3');
const context = await chromium.launchPersistentContext(profile, {
  executablePath: await resolveChromiumPath(), headless: true,
  viewport: { width: 390, height: 640 }, reducedMotion: 'reduce',
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--proxy-server=http://127.0.0.1:18083'],
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/ytray-bootstrap.html?manager=ytray&instanceId=proxy-test&badge=A&startupProxy=${encodeURIComponent('http://127.0.0.1:18083')}&target=chrome://version`);
  await page.waitForURL('chrome://version/');
  await page.goto(`chrome-extension://${id}/options.html`);
  const call = async (action, payload) => {
    const response = await page.evaluate(({ action, payload }) => chrome.runtime.sendMessage({ action, payload }), { action, payload });
    assert.equal(response.ok, true, response.error);
    return response.data;
  };
  const launch = await call('proxy.status');
  assert.equal((await call('state.get')).startupProxy, 'http://127.0.0.1:18083');
  assert.equal(launch.followingStartup, true);
  assert.equal(launch.control, 'controllable_by_this_extension');
  assert.equal(launch.activeProfileId, undefined);
  assert.match(launch.label, /18083/);
  await call('proxy.switch', { id: 'direct' });
  assert.equal((await call('proxy.status')).activeProfileId, 'direct');
  await call('proxy.switch', { id: 'yakit-mitm' });
  assert.equal((await call('proxy.status')).activeProfileId, 'yakit-mitm');
  await call('proxy.auto.apply');
  assert.equal((await call('proxy.status')).activeProfileId, 'auto');
  await call('proxy.switch', { id: 'system' });
  assert.equal((await call('proxy.status')).activeProfileId, 'system');
  await call('proxy.release');
  assert.deepEqual(await call('proxy.status'), launch);
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.getByRole('button', { name: '代理', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '实际代理' }).getByText('http://127.0.0.1:18083', { exact: true }).waitFor();
  assert.equal(await page.getByRole('radio', { name: /直接连接/ }).getAttribute('aria-checked'), 'false');
  const follow = page.getByRole('radio', { name: /跟随启动配置/ });
  assert.equal(await follow.getAttribute('aria-checked'), 'true');
  await page.evaluate(() => {
    const startup = document.querySelector('.startup-proxy-option');
    const ordinary = document.querySelector('.popup-proxy-list > button');
    for (const [a, b] of [[startup.querySelector('.startup-proxy-icon'), ordinary.querySelector('.popup-mode-icon')], [startup.querySelector('strong'), ordinary.querySelector('strong')], [startup.querySelector('small'), ordinary.querySelector('small')]]) {
      if (Math.abs(a.getBoundingClientRect().x - b.getBoundingClientRect().x) > 1) throw new Error('Proxy mode columns are not aligned');
    }
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('radio', { name: /直接连接/ }).click();
  await page.locator('.popup-global-notice').waitFor();
  await page.evaluate(() => {
    const notice = document.querySelector('.popup-global-notice');
    const animation = notice.getAnimations()[0];
    if (!animation) throw new Error('Expected notice entrance animation');
    animation.pause();
    for (const time of [0, 40, 80, 159, 200]) {
      animation.currentTime = time;
      const rect = notice.getBoundingClientRect();
      const parent = notice.offsetParent.getBoundingClientRect();
      if (Math.abs(rect.x + rect.width / 2 - (parent.x + parent.width / 2)) > 1) {
        throw new Error(`Notice is not centered at animation time ${time}ms`);
      }
    }
    animation.finish();
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.querySelector('[aria-label="实际代理状态"]')?.textContent === '实际代理直接连接');
  assert.equal(await follow.getAttribute('aria-checked'), 'false');
  await follow.click();
  await page.waitForFunction(() => document.querySelector('.startup-proxy-option [role="radio"]')?.getAttribute('aria-checked') === 'true');
  assert.deepEqual(await call('proxy.status'), launch);
  await page.getByRole('button', { name: '解释跟随启动配置' }).focus();
  await page.getByRole('tooltip').waitFor();
  assert.match(await page.getByRole('tooltip').innerText(), /切换后使用浏览器启动时的网络配置/);
  assert.doesNotMatch(await page.getByRole('tooltip').innerText(), /清除|接管/);
  await page.getByRole('radio', { name: /跟随启动配置/ }).focus();
  await page.mouse.move(4, 4);
  await mkdir('.artifacts/proxy', { recursive: true });
  await page.screenshot({ path: '.artifacts/proxy/launch-proxy.png' });
  // External settings changes must update an already-open view, without storage mutations.
  await page.evaluate(() => chrome.proxy.settings.set({ scope: 'regular', value: { mode: 'direct' } }));
  await page.getByRole('status').filter({ hasText: '实际代理' }).getByText('直接连接', { exact: true }).waitFor();
  assert.equal(await page.getByRole('radio', { name: /直接连接/ }).getAttribute('aria-checked'), 'false');
  await page.goto(`chrome-extension://${id}/ytray-bootstrap.html?manager=ytray&instanceId=direct-test&badge=A&startupProxy=direct&target=chrome://version`);
  await page.waitForURL('chrome://version/');
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.getByRole('button', { name: '代理', exact: true }).click();
  assert.equal(await page.getByRole('radio', { name: /跟随启动配置/ }).count(), 0);
  console.log('PASS: launch proxy → direct → fixed → PAC → system → release; live status; stale selection not marked active.');
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
