import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { resolveChromiumPath } from './resolve-chromium.mjs'

const root = resolve(import.meta.dirname, '..')
const extensionPath = resolve(root, process.env.EXTENSION_PATH || '.output/chrome-mv3-enterprise')
const targetURL = process.env.AESRSA_TARGET || 'http://127.0.0.1:82/'
const manifest = JSON.parse(await readFile(resolve(extensionPath, 'manifest.json'), 'utf8'))
const executablePath = await resolveChromiumPath()
const userDataDir = await mkdtemp(join(tmpdir(), 'yakit-aesrsa-'))
let context

async function extensionRequest(page, action, payload = {}) {
  return page.evaluate(async ({ requestAction, requestPayload }) => {
    const response = await chrome.runtime.sendMessage({ action: requestAction, payload: requestPayload })
    if (!response?.ok) throw new Error(response?.error?.message || response?.error || requestAction)
    return response.data
  }, { requestAction: action, requestPayload: payload })
}

async function waitFor(page, action, payload, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let value
  while (Date.now() < deadline) {
    value = await extensionRequest(page, action, payload)
    if (predicate(value)) return value
    await page.waitForTimeout(150)
  }
  throw new Error(`Timed out waiting for ${action}: ${JSON.stringify(value)}`)
}

try {
  context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: true,
    viewport: { width: 1280, height: 760 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })
  let serviceWorker = context.serviceWorkers()[0]
  if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15_000 })
  const extensionId = new URL(serviceWorker.url()).host

  if (manifest.permissions?.includes('userScripts')) {
    const extensionsPage = await context.newPage()
    await extensionsPage.goto(`chrome://extensions/?id=${extensionId}`)
    const toggle = extensionsPage.locator('#allow-user-scripts cr-toggle')
    await toggle.waitFor({ state: 'visible', timeout: 10_000 })
    if (!await toggle.evaluate((element) => Boolean(element.checked))) await toggle.click()
    await extensionsPage.close()
  }

  const targetPage = await context.newPage()
  targetPage.on('dialog', (dialog) => void dialog.dismiss())
  let browserRequestCount = 0
  targetPage.on('request', (request) => {
    if (new URL(request.url()).pathname === '/encrypt/aesrsa.php') browserRequestCount += 1
  })
  await targetPage.goto(targetURL)

  const controlPage = await context.newPage()
  await controlPage.goto(`chrome-extension://${extensionId}/options.html`)
  const tabId = await controlPage.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({})
    return tabs.find((tab) => tab.url === url)?.id
  }, targetPage.url())
  if (!tabId) throw new Error('Could not resolve the AES+RSA target tab')

  await extensionRequest(controlPage, 'recording.start', {
    tabId, frameId: 0, captureValues: true, maxEntries: 120, maxValueBytes: 8_192,
  })
  await targetPage.locator('#username').fill('admin')
  await targetPage.locator('#password').fill('wrong-password')
  await targetPage.getByRole('button', { name: '登录', exact: true }).click()
  await targetPage.getByRole('button', { name: 'AES+Rsa加密', exact: true }).click()
  await targetPage.waitForTimeout(500)
  if (browserRequestCount !== 1) throw new Error(`Initial recording expected one real request, received ${browserRequestCount}`)

  const snapshot = await extensionRequest(controlPage, 'recording.get', { tabId, frameId: 0, limit: 120 })
  const candidate = snapshot.profileCandidates?.find((item) => (
    item.status === 'capture-required'
      && item.sources?.length === 3
      && new URL(item.request?.url, targetURL).pathname === '/encrypt/aesrsa.php'
  ))
  if (!candidate) throw new Error(`AES+RSA request-level candidate was not inferred: ${JSON.stringify(snapshot)}`)
  const matcherEvent = snapshot.events?.find((event) => event.id === candidate.capturePlan?.matcherEventId)
  if (!matcherEvent?.crypto?.adapterId || !matcherEvent.wrapperHandleId) {
    throw new Error(`AES+RSA candidate has no deep-capture matcher: ${JSON.stringify(candidate)}`)
  }
  await extensionRequest(controlPage, 'deep.capture.start', {
    tabId,
    frameId: 0,
    matcher: {
      kind: 'crypto',
      adapterId: matcherEvent.crypto.adapterId,
      operation: matcherEvent.crypto.operation,
      wrapperHandleId: matcherEvent.wrapperHandleId,
      scriptUrl: matcherEvent.scriptUrl,
      frameHints: candidate.capturePlan.frameHints,
    },
  })

  await targetPage.locator('#username').fill('admin')
  await targetPage.locator('#password').fill('wrong-password')
  await targetPage.getByRole('button', { name: '登录', exact: true }).click()
  let replayClickFailure
  const replayClick = targetPage.getByRole('button', { name: 'AES+Rsa加密', exact: true })
    .click({ noWaitAfter: true, timeout: 20_000 })
    .catch((reason) => { replayClickFailure = reason })
  const paused = await waitFor(controlPage, 'deep.capture.status', { tabId, frameId: 0 }, (value) => (
    value?.state === 'paused' && value.pause?.collecting !== true
  ), 20_000)
  const automatic = paused.pause?.automaticCapture
  const frame = paused.pause?.frames?.find((item) => item.id === automatic?.frameId)
  if (automatic?.state !== 'ready' || automatic.strategy !== 'request-transaction'
    || frame?.functionName !== 'sendDataAesRsa') {
    throw new Error(`Deep capture did not select sendDataAesRsa as a request transaction: ${JSON.stringify(paused)}`)
  }

  const callable = await extensionRequest(controlPage, 'callable.create', {
    tabId,
    frameId: 0,
    source: 'deep-capture',
    strategy: 'request-transaction',
    callFrameId: frame.id,
    name: 'sendDataAesRsa 请求事务',
    transaction: {
      request: {
        method: candidate.request.method,
        url: candidate.request.url,
        expectedDestinations: candidate.sources.map((source) => source.destination).filter(Boolean),
      },
      inputMode: 'auto',
      boundaries: ['fetch', 'xhr', 'beacon', 'form'],
    },
  })
  if (callable.kind !== 'request-transaction' || callable.inputSlots?.[0]?.name !== 'body') {
    throw new Error(`Captured callable is not a request transaction: ${JSON.stringify(callable)}`)
  }
  await replayClick
  if (replayClickFailure) throw replayClickFailure
  await targetPage.waitForTimeout(300)
  if (browserRequestCount !== 1) {
    throw new Error(`Deep-capture replay leaked a real request; observed ${browserRequestCount}`)
  }

  let execution
  try {
    execution = await extensionRequest(controlPage, 'callable.execute', {
      tabId,
      frameId: 0,
      callableId: callable.id,
      args: [{ username: 'admin', password: '123456' }],
    })
  } catch (reason) {
    const diagnostics = await controlPage.evaluate(async ({ targetTabId, callableId }) => {
      const tab = await chrome.tabs.get(targetTabId).catch(() => undefined)
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: targetTabId, frameIds: [0] },
        world: 'MAIN',
        func: async (registryKey, protocolVersion, requestedCallableId) => {
          const controller = globalThis[registryKey]
          let directExecution
          try {
            directExecution = {
              ok: true,
              value: await controller?.command('callable.execute', {
                callableId: requestedCallableId,
                args: [{ username: 'admin', password: '123456' }],
              }),
            }
          } catch (error) {
            directExecution = {
              ok: false,
              error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ''}` : String(error),
            }
          }
          return {
            href: location.href,
            controllerVersion: controller?.version,
            expectedVersion: protocolVersion,
            callables: typeof controller?.command === 'function' ? controller.command('callable.list', {}) : [],
            directExecution,
          }
        },
        args: ['__YAKIT_PAGE_RECORDER_V8__', 8, callableId],
      }).catch(() => [])
      return { tabUrl: tab?.url, page: injection?.result }
    }, { targetTabId: tabId, callableId: callable.id })
    const selectedFrame = {
      functionName: frame.functionName,
      functionInspection: frame.functionInspection,
      scopes: frame.scopes,
    }
    throw new Error(`Callable execution failed: ${reason instanceof Error ? reason.message : String(reason)}; browserRequests=${browserRequestCount}; frame=${JSON.stringify(selectedFrame)}; diagnostics=${JSON.stringify(diagnostics)}`)
  }
  const envelope = execution.value
  for (const field of ['encryptedData', 'encryptedKey', 'encryptedIv']) {
    if (typeof envelope?.[field] !== 'string' || !envelope[field]) {
      throw new Error(`Transaction output is missing ${field}: ${JSON.stringify(execution)}`)
    }
  }
  if (browserRequestCount !== 1) {
    throw new Error(`Transaction execution leaked a real browser request; observed ${browserRequestCount}`)
  }

  const response = await fetch(new URL('/encrypt/aesrsa.php', targetURL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  })
  const result = await response.json()
  if (!result.success) throw new Error(`Target server rejected the transaction envelope: ${JSON.stringify(result)}`)
  process.stdout.write('AES+RSA request transaction verified: no browser request leaked and the target server accepted the captured envelope.\n')
} finally {
  await context?.close().catch(() => undefined)
  await rm(userDataDir, { recursive: true, force: true })
}
