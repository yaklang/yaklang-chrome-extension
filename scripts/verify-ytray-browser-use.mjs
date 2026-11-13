import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const config = JSON.parse(await readFile(process.env.YTRAY_BROWSER_CONFIG, 'utf8')).mcpServers['ytray-browser'];
const executablePath = process.env.YTRAY_CHROME_PATH;
const agentExecutable = process.env.YTRAY_TEST_AGENT;
const enrollments = process.env.YTRAY_BROWSER_ENROLLMENTS
  ? JSON.parse(await readFile(process.env.YTRAY_BROWSER_ENROLLMENTS, 'utf8')) : undefined;
const artifacts = resolve(process.env.YTRAY_BROWSER_ARTIFACTS || '.artifacts/browser-use');
const temporary = await mkdtemp(join(tmpdir(), 'ytray-browser-use-'));
const extension = join(temporary, 'extension');
const marker = 'YTray Browser Use';
const contexts = [];
const record = [];
const fixture = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture.test');
  const query = url.searchParams.get('q');
  const label = url.pathname === '/allowed' ? 'Authorized fixture' : url.pathname === '/results' ? 'Search results' : 'Other fixture';
  const escapedQuery = (query || '').replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><title>${label}</title><style>
    body{margin:0;min-height:2500px;background:#f7f9fc;color:#162030;font:16px system-ui}
    main{position:sticky;top:0;background:white;border-bottom:1px solid #d5deeb;padding:32px}
    input,button{font:inherit;padding:8px} label{display:inline-flex;align-items:center;gap:12px}
    output{display:block;margin-top:14px}</style>
    <main><h1>${label}</h1><form ${enrollments && url.pathname === '/allowed'
      ? 'action="/results"'
      : 'onsubmit="event.preventDefault(); document.querySelector(\'output\').textContent = \'Saved: \' + document.querySelector(\'input\').value"'}>
      <label>Test message <input id="message" name="q" autocomplete="off"></label>
      <button id="save" type="submit">Save marker</button>
    </form><output>${query === null ? '' : 'Saved: ' + escapedQuery}</output>
    <a href="/other" target="_blank">Open a new tab</a></main><p style="margin:650px 32px">Scroll checkpoint</p>`);
});
await new Promise((ready) => fixture.listen(0, '127.0.0.1', ready));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let requestId = 0;
let protocolVersion;
async function mcp(method, params, notification = false, headers = config.headers) {
  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++requestId }), method, params }),
    signal: AbortSignal.timeout(12_000),
  });
  if (notification) { assert.equal(response.status, 202); return; }
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json();
  assert(!payload.error, JSON.stringify(payload.error));
  return payload.result;
}
const call = (name, args = {}) => mcp('tools/call', { name, arguments: args });
const pages = async () => (await call('browser_list_pages')).structuredContent.pages;
const expectToolError = async (name, args, code) => {
  const result = await call(name, args);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, code);
};
async function until(check, message, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await sleep(75);
  } while (Date.now() < deadline);
  throw new Error(message);
}

async function launch(label, url) {
  const context = await chromium.launchPersistentContext(join(temporary, label), {
    executablePath,
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1040,780'],
  });
  contexts.push(context);
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const popup = await context.newPage();
  await popup.goto(new URL('/popup.html', worker.url()).href);
  const page = context.pages().find((entry) => entry !== popup) ?? await context.newPage();
  const enrollment = enrollments?.[label];
  if (enrollment) {
    const bootstrap = new URL('/ytray-bootstrap.html', worker.url());
    bootstrap.search = new URLSearchParams({
      manager: 'ytray', instanceId: enrollment.instanceId, badge: label,
      target: url, engineTarget: JSON.stringify({ mode: 'none' }), browserUseTicket: enrollment.ticket,
    }).toString();
    await page.goto(bootstrap.href);
    await page.waitForURL(url);
  } else {
    await page.goto(url);
  }
  await page.locator('yakit-browser-agent').waitFor({ state: 'attached' });
  await page.bringToFront();
  const id = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, url);
  return { context, worker, popup, page, id };
}

async function popupRequest(browser, action, payload = {}) {
  const response = await browser.popup.evaluate(([action, payload]) => chrome.runtime.sendMessage({ action, payload }),
    [action, { tabId: browser.id, ...payload }]);
  assert.equal(response.ok, true, response.error);
  return response.data;
}

async function share(browser) {
  await browser.worker.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), browser.id);
  await browser.popup.getByRole('button', { name: '共享此页', exact: true }).click();
  await browser.popup.getByRole('button', { name: '停止共享', exact: true }).waitFor({ timeout: 8_000 }).catch(async (error) => {
    throw new Error(await browser.popup.locator('.popup-global-notice').textContent({ timeout: 1_000 }).catch(() => error.message));
  });
  await browser.worker.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), browser.id);
}

async function runAgent() {
  const prompt = `Use only ytray_browser MCP tools to fill and submit the localhost form titled Authorized fixture${enrollments ? ' in instance A' : ''}. Call browser_list_pages by itself first. Select the page with the matching title and call browser_observe using its page_id. For the Test message field use browser_type with text exactly "${marker}". Click Save marker with browser_click.${enrollments ? ' The form navigates to a results page in the same tab. After clicking, call browser_observe with the same page_id. If the page is still navigating, observe again. Only scroll after reading the results.' : ''} Scroll down by calling browser_scroll with only page_id and delta_y of 700. Finally observe and report the text after Saved. Wait for each tool's result. Copy actual ID values from the tool output. Do not submit until browser_type has succeeded.`;
  const agentArgs = JSON.parse(process.env.YTRAY_TEST_AGENT_ARGS || '[]');
  const agentConfig = JSON.parse(process.env.YTRAY_TEST_AGENT_CONFIG || '{}');
  const child = spawn(agentExecutable, [...agentArgs, '--pure', 'run', '--format', 'json', '--model', process.env.YTRAY_TEST_MODEL, prompt], {
    cwd: process.env.YTRAY_AGENT_DIRECTORY,
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...agentConfig,
        small_model: process.env.YTRAY_TEST_MODEL,
        mcp: {
          'chrome-devtools': { enabled: false },
          shadcn: { enabled: false },
          ytray_browser: {
            type: 'remote', url: config.url, oauth: false, protocol: 'legacy',
            headers: { Authorization: '{env:YTRAY_AGENT_AUTHORIZATION}' },
          },
        },
        permission: { '*': 'deny', 'ytray_browser_*': 'allow' },
      }),
      YTRAY_AGENT_AUTHORIZATION: config.headers.Authorization,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (text) => { output += text; });
  child.stderr.setEncoding('utf8').on('data', (text) => { stderr += text; });
  const status = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { child.kill(); reject(new Error('OpenCode task timed out')); }, 240_000);
    child.on('error', (error) => { clearTimeout(deadline); reject(error); });
    child.on('close', (code) => { clearTimeout(deadline); resolve(code); });
  });
  const events = output.split(/\r?\n/).filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  const toolNames = events.filter((event) => event.type === 'tool_use').map((event) => event.part.tool);
  const answer = events.filter((event) => event.type === 'text').map((event) => event.part.text).join('\n');
  const error = events.find((event) => event.type === 'error')?.error;
  record.push({ agent: 'OpenCode', toolNames, answer });
  if (status !== 0 || error || !toolNames.length) {
    const detail = error?.data?.message || stderr.trim().slice(0, 500) || answer;
    throw new Error(`OpenCode failed (${status}): ${detail.replaceAll(config.headers.Authorization, '[redacted]')}`);
  }
  assert(toolNames.every((name) => name.startsWith('ytray_browser_browser_')), JSON.stringify(toolNames));
  for (const tool of ['list_pages', 'observe', 'type', 'click', 'scroll']) {
    assert(toolNames.includes(`ytray_browser_browser_${tool}`), `Agent did not call ${tool}`);
  }
  assert.match(answer, /Saved: YTray Browser Use/);
}

try {
  await mkdir(artifacts, { recursive: true });
  const builtExtension = process.env.YTRAY_TEST_EXTENSION || resolve(import.meta.dirname, '..', '.output/chrome-mv3-enterprise');
  await cp(builtExtension, extension, { recursive: true });
  const manifestPath = join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (enrollments) {
    assert(manifest.permissions.includes('nativeMessaging'), 'Test the actual managed bundle permissions');
  } else if (!manifest.permissions.includes('nativeMessaging')) {
    assert(manifest.optional_permissions.includes('nativeMessaging'));
    // Standalone store-build tests cannot interact with Chrome permission dialogs.
    manifest.permissions.push('nativeMessaging');
    manifest.optional_permissions = manifest.optional_permissions.filter((permission) => permission !== 'nativeMessaging');
    await writeFile(manifestPath, JSON.stringify(manifest));
  }

  protocolVersion = (await mcp('initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ytray-browser-verifier', version: '1' },
  })).protocolVersion;
  await mcp('notifications/initialized', {}, true);
  assert.equal((await mcp('tools/list', {})).tools.length, 5);
  assert.deepEqual(await pages(), []);

  const allowed = await launch('A', `${origin}/allowed`);
  const denied = await launch('B', `${origin}/other`);
  if (!enrollments) await share(allowed);
  const grant = await until(async () => (await pages()).find((entry) => entry.url === `${origin}/allowed`),
    'Expected the A instance page');
  assert.equal(grant.title, 'Authorized fixture');
  assert.equal(grant.managed, Boolean(enrollments));
  assert.equal((await popupRequest(allowed, 'browser-use.share.status')).shared, true);
  if (!enrollments) assert.equal((await popupRequest(denied, 'browser-use.share.status')).shared, false);
  const fromPage = await denied.worker.evaluate((tabId) => chrome.scripting.executeScript({
    target: { tabId },
    func: async (tabId) => chrome.runtime.sendMessage({ action: 'browser-use.share.start', payload: { tabId, url: location.href } }),
    args: [tabId],
  }), denied.id);
  assert.equal(fromPage[0].result.errorCode, 'forbidden_sender');
  await expectToolError('browser_observe', { page_id: 'p999999' }, 'page_not_shared');

  const first = await call('browser_observe', { page_id: grant.page_id });
  assert.equal(first.isError, false);
  const firstCapture = first.structuredContent;
  const input = firstCapture.nodes.find((node) => node.tag === 'input');
  assert(input, 'Fixture input absent');
  if (!enrollments) await share(denied);
  const both = await until(async () => {
    const entries = await pages();
    return entries.length === 2 && entries;
  }, 'Expected a distinct second browser grant');
  const secondGrant = both.find((page) => page.page_id !== grant.page_id);
  assert.notEqual(grant.instance_id, secondGrant.instance_id);
  if (enrollments) {
    assert.equal(grant.instance_label, 'A');
    assert.equal(secondGrant.instance_label, 'B');
    assert.equal((await popupRequest(denied, 'browser-use.share.status')).shared, true);
  }
  await call('browser_observe', { page_id: secondGrant.page_id });
  await expectToolError('browser_type', {
    page_id: secondGrant.page_id, capture_id: firstCapture.capture_id, node_id: input.node_id, text: 'should not write',
  }, 'stale_node');
  if (!enrollments) {
    await popupRequest(denied, 'browser-use.share.stop');
    await until(async () => (await pages()).length === 1, 'Revoked page still listed');
    await expectToolError('browser_observe', { page_id: secondGrant.page_id }, 'page_not_shared');
  }
  assert.equal(await denied.page.locator('#message').inputValue(), '');

  const box = '[data-ytray-action-feedback]';
  const rendered = new Set();
  for (const entry of [allowed, denied]) {
    await entry.page.evaluate(() => {
      const root = document.querySelector('yakit-browser-agent').shadowRoot;
      const changes = [];
      const observer = new MutationObserver(() => {
        const box = root.querySelector('[data-ytray-action-feedback]');
        if (box && !box.hidden) changes.push(box.textContent);
      });
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
      window.feedbackSeen = changes;
      addEventListener('pagehide', () => sessionStorage.setItem('fixture-feedback', JSON.stringify(changes)));
    });
  }
  let taskFinished = false;
  const screenshot = (async () => {
    while (!taskFinished && rendered.size < 2) {
      const label = await allowed.page.locator(box).textContent({ timeout: 250 }).catch(() => '');
      if (label && !rendered.has(label)) {
        await allowed.page.screenshot({ path: join(artifacts, label === '输入' ? 'authorized-input.png' : 'authorized-click.png') });
        rendered.add(label);
      }
      await sleep(100);
    }
  })();
  try {
    if (agentExecutable) await runAgent();
    else {
      const { capture_id, nodes } = (await call('browser_observe', { page_id: grant.page_id })).structuredContent;
      for (const [name, node, text] of [
        ['browser_type', nodes.find((node) => node.tag === 'input'), marker],
        ['browser_click', nodes.find((node) => node.label === 'Save marker')],
      ]) {
        const result = await call(name, { page_id: grant.page_id, capture_id, node_id: node.node_id, ...(text ? { text } : {}) });
        assert.equal(result.isError, false, result.content?.[0]?.text);
        await sleep(350);
      }
      if (enrollments) {
        await allowed.page.waitForURL(/\/results\?q=/);
        const changed = await until(async () => (await pages()).find((entry) => entry.url.includes('/results?')), 'Result page not listed');
        assert.equal(changed.page_id, grant.page_id);
        await expectToolError('browser_type', {
          page_id: grant.page_id, capture_id, node_id: input.node_id, text: 'stale operation',
        }, 'stale_node');
        const observed = await call('browser_observe', { page_id: grant.page_id });
        assert.equal(observed.isError, false, observed.content?.[0]?.text);
        assert.match(observed.structuredContent.text, /Saved: YTray Browser Use/);
        assert.notEqual(observed.structuredContent.capture_id, capture_id);
      }
      assert.equal((await call('browser_scroll', { page_id: grant.page_id, delta_y: 700 })).isError, false);
    }
    await allowed.page.waitForFunction((marker) => document.querySelector('output').textContent === `Saved: ${marker}`, marker, { timeout: 6_000 });
    assert.equal(await allowed.page.evaluate(() => scrollY), 700);
    assert.equal(await denied.page.locator('#message').inputValue(), '');
    assert.equal(await denied.page.locator('output').textContent(), '');
    assert.equal(await denied.page.evaluate(() => scrollY), 0);
    assert.deepEqual(await denied.page.evaluate(() => window.feedbackSeen), []);
    const feedback = await allowed.page.evaluate(() => Array.from(new Set(
      window.feedbackSeen || JSON.parse(sessionStorage.getItem('fixture-feedback') || '[]'),
    )));
    assert(feedback.includes('输入') && (enrollments || feedback.includes('点击')), JSON.stringify(feedback));
    taskFinished = true;
    await screenshot;
    await denied.page.screenshot({ path: join(artifacts, 'unshared-page.png') });
    record.push({ authorized: { marker, scrollY: 700, feedback }, other: { marker: '', scrollY: 0, feedback: [] } });
  } catch (error) {
    taskFinished = true;
    void screenshot.catch(() => undefined);
    throw error;
  }

  if (enrollments) {
    const capture = (await call('browser_observe', { page_id: grant.page_id })).structuredContent.capture_id;
    await allowed.page.reload();
    await expectToolError('browser_click', { page_id: grant.page_id, capture_id: capture, node_id: input.node_id }, 'stale_node');
    const reloaded = await call('browser_observe', { page_id: grant.page_id });
    assert.equal(reloaded.isError, false, reloaded.content?.[0]?.text);
    const newTab = allowed.context.waitForEvent('page', { timeout: 6_000 });
    const link = reloaded.structuredContent.nodes.find((node) => node.label === 'Open a new tab');
    assert(link);
    const clicked = await call('browser_click', { page_id: grant.page_id, capture_id: reloaded.structuredContent.capture_id, node_id: link.node_id });
    assert.equal(clicked.isError, false, clicked.content?.[0]?.text);
    const popup = await newTab;
    await popup.waitForURL(`${origin}/other`);
    await sleep(500);
    assert.equal((await pages()).length, 2, 'A tab opened by an action was attached automatically');
    await popup.close();
    await popupRequest(denied, 'browser-use.share.stop');
    await until(async () => (await pages()).length === 1, 'Paused tab still listed');
    await expectToolError('browser_observe', { page_id: secondGrant.page_id }, 'page_not_shared');
    await allowed.page.goto(`http://localhost:${fixture.address().port}/other`);
    await until(async () => (await pages()).length === 0, 'Cross-site navigation did not end page access');
    await expectToolError('browser_observe', { page_id: grant.page_id }, 'page_not_shared');
    await sleep(500);
    assert.deepEqual(await pages(), []);
  } else {
    await allowed.page.reload();
    await until(async () => (await pages()).length === 0, 'Reload did not revoke the document');
    await expectToolError('browser_click', { page_id: grant.page_id, capture_id: firstCapture.capture_id, node_id: input.node_id }, 'page_not_shared');
  }
  assert.equal(await allowed.page.locator(box).count(), 0);
  record.push({ crossInstanceCapture: 'stale_node', revoked: 'page_not_shared', reloaded: enrollments ? 'same_page_id' : 'page_not_shared',
    ...(enrollments ? { automaticAttachment: true, sameOriginFormNavigation: 'same_page_id', crossOriginNavigation: 'page_not_shared',
      actionOpenedTab: 'not_shared' } : {}) });
  console.log(JSON.stringify(record, null, 2));
} finally {
  await writeFile(join(artifacts, 'browser-use-results.json'), JSON.stringify(record, null, 2)).catch(() => undefined);
  await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
  fixture.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
