import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {chromium} from 'playwright-core'
import {resolveChromiumPath} from './resolve-chromium.mjs'

const root = resolve(import.meta.dirname, '..')

export async function extensionRequest(page, action, payload = {}) {
  return page.evaluate(async ({requestAction, requestPayload}) => {
    const response = await chrome.runtime.sendMessage({action: requestAction, payload: requestPayload})
    if (!response?.ok) throw new Error(response?.error?.message || response?.error || requestAction)
    return response.data
  }, {requestAction: action, requestPayload: payload})
}

export async function waitFor(page, action, payload, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let value
  while (Date.now() < deadline) {
    value = await extensionRequest(page, action, payload)
    if (predicate(value)) return value
    await page.waitForTimeout(150)
  }
  throw new Error(`Timed out waiting for ${action}: ${JSON.stringify(value)}`)
}

export async function launchBrowserAgentContractHarness({
  profilePrefix,
  targetURL,
  extensionPath = resolve(root, process.env.EXTENSION_PATH || '.output/chrome-mv3-enterprise'),
}) {
  const manifest = JSON.parse(await readFile(resolve(extensionPath, 'manifest.json'), 'utf8'))
  const executablePath = await resolveChromiumPath()
  const userDataDir = await mkdtemp(join(tmpdir(), profilePrefix))
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: true,
    viewport: {width: 1280, height: 760},
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })
  try {
    let serviceWorker = context.serviceWorkers()[0]
    if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker', {timeout: 15_000})
    const extensionId = new URL(serviceWorker.url()).host

    if (manifest.permissions?.includes('userScripts')) {
      const extensionsPage = await context.newPage()
      await extensionsPage.goto(`chrome://extensions/?id=${extensionId}`)
      const toggle = extensionsPage.locator('#allow-user-scripts cr-toggle')
      await toggle.waitFor({state: 'visible', timeout: 10_000})
      if (!await toggle.evaluate((element) => Boolean(element.checked))) await toggle.click()
      await extensionsPage.close()
    }

    const targetPage = await context.newPage()
    targetPage.on('dialog', (dialog) => void dialog.dismiss())
    await targetPage.goto(targetURL)

    const controlPage = await context.newPage()
    await controlPage.goto(`chrome-extension://${extensionId}/options.html`)
    const tabId = await controlPage.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({})
      return tabs.find((tab) => tab.url === url)?.id
    }, targetPage.url())
    if (!tabId) throw new Error(`Could not resolve target tab ${targetPage.url()}`)

    return {
      context,
      controlPage,
      extensionId,
      tabId,
      targetPage,
      async close() {
        await context.close().catch(() => undefined)
        await rm(userDataDir, {recursive: true, force: true})
      },
    }
  } catch (error) {
    await context.close().catch(() => undefined)
    await rm(userDataDir, {recursive: true, force: true})
    throw error
  }
}

export function transformedFetchOptions(execution, originalHeaders) {
  const headers = new Map(originalHeaders.map((header) => [header.name.toLowerCase(), {
    name: header.name,
    value: header.value,
  }]))
  for (const name of execution.removeHeaders || []) headers.delete(name.toLowerCase())
  for (const header of execution.setHeaders || []) {
    headers.set(header.name.toLowerCase(), {name: header.name, value: header.value})
  }
  return {
    method: 'POST',
    headers: Object.fromEntries([...headers.values()].map((header) => [header.name, header.value])),
    body: Buffer.from(execution.bodyBase64, 'base64'),
  }
}
