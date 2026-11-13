import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { resolveChromiumPath } from './resolve-chromium.mjs';

const profile = await mkdtemp(join(tmpdir(), 'browser-use-feedback-'));
const extension = resolve(import.meta.dirname, '..', '.output/chrome-mv3-enterprise');
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><title>Browser Use fixture</title>
    <body style="height:2400px;margin:0">
    <form style="position:absolute;top:360px;left:20vw" onsubmit="event.preventDefault()">
      <label>Search <input id="search"></label>
      <button id="apply" onclick="this.dataset.clicked = 'yes'">Apply</button>
    </form></body>`);
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: await resolveChromiumPath(),
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1000,800'],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const popup = await context.newPage();
  await popup.goto(new URL('/popup.html', worker.url()).href);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const target = await context.newPage();
  const other = await context.newPage();
  await other.goto(`${url}other`);
  await target.goto(url);
  await target.bringToFront();
  await target.locator('yakit-browser-agent').waitFor({ state: 'attached' });
  const tabId = await worker.evaluate(async (pageUrl) => (await chrome.tabs.query({ url: pageUrl }))[0].id, url);
  const otherId = await worker.evaluate(async (pageUrl) => (await chrome.tabs.query({ url: pageUrl }))[0].id, `${url}other`);
  const request = async (action, payload) => {
    const result = await popup.evaluate(([action, payload]) => chrome.runtime.sendMessage({ action, payload }), [action, { tabId, ...payload }]);
    assert.equal(result.ok, true, result.error);
    return result.data;
  };
  const snapshot = await request('context.capture', {});
  const act = (selectorHint, action, value) => request('context.node.action', {
    captureId: snapshot.captureId,
    nodeId: snapshot.document.interactive.find((node) => node.selectorHint === selectorHint).nodeId,
    action,
    value,
  });
  const box = target.locator('[data-ytray-action-feedback]');
  const assertAligned = async (selector) => {
    await target.waitForFunction((selector) => {
      const element = document.querySelector(selector);
      const box = document.querySelector('yakit-browser-agent')?.shadowRoot?.querySelector('[data-ytray-action-feedback]');
      if (!box) return false;
      const actual = box.getBoundingClientRect();
      const expected = element.getBoundingClientRect();
      return ['left', 'top', 'width', 'height'].every((key) => Math.abs(actual[key] - expected[key]) < 1);
    }, selector, { timeout: 1_800 });
  };

  await act('#search', 'setValue', 'browser use');
  await assertAligned('#search');
  assert.equal(await target.locator('#search').inputValue(), 'browser use');
  assert.equal(await target.locator('#search').evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return document.elementFromPoint(x + width / 2, y + height / 2) === element;
  }), true);
  const scale = await target.evaluate(() => devicePixelRatio);
  await target.evaluate(() => scrollBy(0, 150));
  await target.waitForFunction(() => scrollY === 150);
  await assertAligned('#search');
  await worker.evaluate((tab) => chrome.tabs.setZoom(tab, 1.25), tabId);
  await target.waitForFunction((scale) => Math.abs(devicePixelRatio / scale - 1.25) < 0.02, scale);
  await assertAligned('#search');
  await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), otherId);
  await box.waitFor({ state: 'detached', timeout: 1_800 });
  assert.equal(await other.locator('[data-ytray-action-feedback]').count(), 0);
  await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), tabId);
  assert.equal(await box.count(), 0);
  await act('#apply', 'click');
  await assertAligned('#apply');
  await target.waitForFunction(() => document.querySelector('#apply').dataset.clicked === 'yes');
  assert.equal(await other.locator('#apply').getAttribute('data-clicked'), null);
  await target.reload();
  assert.equal(await box.count(), 0);
  console.log('Browser Use feedback verified: input, click, pointer pass-through, scroll, 125% browser zoom, tab switch, reload.');
} finally {
  await context?.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
