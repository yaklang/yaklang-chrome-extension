import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extensionRequest, launchBrowserAgentContractHarness, waitFor } from './browser-agent-contract-harness.mjs'

const registryKey = (await readFile(new URL('../src/features/page-callable/constants.ts', import.meta.url), 'utf8')).match(/= '([^']+)'/)[1]
const received = []
const server = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) body += chunk
  received.push({ url: request.url, method: request.method, body })
  if (request.url === '/key' || request.url === '/bad-key') {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(request.url === '/key' ? { key: 'fresh-server-key' } : {}))
  } else if (request.method === 'POST') {
    response.setHeader('Content-Type', 'application/json')
    response.end('{}')
  } else {
    response.setHeader('Content-Type', 'text/html')
    response.end('<form id="form"><input name="password" value="old"><button>Submit</button></form><script>globalThis.cachedFetch = fetch.bind(window); globalThis.cachedSubmit = HTMLFormElement.prototype.submit;</script>')
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const targetURL = `http://127.0.0.1:${server.address().port}/`
let harness
try {
  harness = await launchBrowserAgentContractHarness({ profilePrefix: 'yakit-capture-regressions-', targetURL })
  const { controlPage, targetPage, tabId } = harness
  const target = { tabId, frameId: 0 }
  const request = (action, payload = {}) => extensionRequest(controlPage, action, { ...target, ...payload })
  await request('recording.start', { captureValues: true, maxEntries: 200, maxValueBytes: 8192 })

  await targetPage.evaluate(async () => {
    await fetch(new Request(location.origin + '/request-object', { method: 'POST', body: 'encrypted-request-body' }))
  })
  const recorded = await waitFor(controlPage, 'recording.get', target, snapshot => snapshot.events.some(event =>
    event.url?.endsWith('/request-object') && event.inputs.some(value => value.path === '$body' && value.preview === 'encrypted-request-body')))
  assert(recorded.events.some(event => event.url?.endsWith('/request-object')))

  async function register(mode, transaction = false) {
    return targetPage.evaluate(({ key, mode, transaction }) => {
      const id = crypto.randomUUID()
      const endpoint = location.origin + '/' + mode
      const savedState = { password: 'old' }
      const prerequisites = mode.startsWith('prerequisite') ? [{
        boundary: 'fetch', method: 'GET', url: location.origin + (mode === 'prerequisite-invalid' ? '/bad-key' : '/key'),
        requestBodyFormat: 'none', maxRequestBodyBytes: 0,
        response: { statusCode: 200, url: location.origin + (mode === 'prerequisite-invalid' ? '/bad-key' : '/key'), bodyFormat: 'json', maxBodyBytes: 4096, requiredPaths: ['body.key'] },
      }] : []
      if (mode === 'controlled') document.querySelector('input').addEventListener('input', event => { savedState.password = event.target.value })
      const metadata = {
        id, name: mode, kind: transaction ? 'request-transaction' : 'business-closure', operation: mode,
        origin: location.origin, lifecycle: 'document', execution: { resultMode: 'auto', timeoutMs: 1500 },
        inputSlots: [{ id: 'body', name: 'body', index: 0, role: 'data', dataType: 'object', required: true, retained: false }],
        output: { dataType: transaction ? 'object' : 'string', encoding: transaction ? 'json' : 'utf8', shape: transaction ? 'envelope' : 'value', paths: transaction ? ['body.password'] : [] },
        provenance: {}, createdAt: Date.now(),
        ...(transaction ? { transaction: { version: 2, prerequisites, inputMode: 'auto', request: {
          boundary: mode === 'multipart-xhr' ? 'xhr' : mode === 'multipart-beacon' ? 'beacon' : 'fetch',
          method: 'POST', url: endpoint, bodyFormat: mode.startsWith('multipart') ? 'form' : 'json', expectedDestinations: ['body.password'],
        } } } : {}),
      }
      const registry = globalThis[key] ||= new Map()
      registry.set(id, { metadata, invoke(args) {
        if (mode === 'native-form') {
          const form = document.querySelector('form'); form.method = 'POST'; form.action = endpoint
          Reflect.apply(globalThis.cachedSubmit, form, []); return 'unexpected'
        }
        if (mode === 'cached') return globalThis.cachedFetch(endpoint, { method: 'POST', body: 'leak' }).then(() => 'bad')
        if (mode === 'timer') { setTimeout(() => fetch(endpoint, { method: 'POST', body: 'leak' }), 100); return 'ok' }
        const value = mode === 'stale' || mode === 'controlled' ? savedState : args[0]
        const send = () => {
          if (mode.startsWith('multipart')) {
            const form = new FormData(); form.set('password', value.password)
            if (mode === 'multipart-xhr') { const xhr = new XMLHttpRequest(); xhr.open('POST', endpoint); return xhr.send(form) }
            if (mode === 'multipart-beacon') return navigator.sendBeacon(endpoint, form)
            return fetch(endpoint, { method: 'POST', body: form })
          }
          return fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
        }
        if (mode.startsWith('concurrent')) return new Promise(resolve => setTimeout(resolve, 40)).then(send)
        if (prerequisites.length) return fetch(mode === 'prerequisite-unplanned' ? '/unplanned' : prerequisites[0].url).then(response => response.json()).then(send)
        return send()
      } })
      return id
    }, { key: registryKey, mode, transaction })
  }
  const execute = (id, password = 'new') => request('callable.execute', { callableId: id, args: [{ password }] })
  await assert.rejects(execute(await register('cached')), /fetch|网络|阻止|Failed/i)
  assert.equal((await execute(await register('timer'))).value, 'ok')
  await targetPage.waitForTimeout(160)
  assert(!received.some(item => ['/cached', '/timer'].includes(item.url)))
  await assert.rejects(execute(await register('stale', true)), /新明文|旧状态/)
  for (const mode of ['controlled', 'multipart', 'multipart-xhr', 'multipart-beacon']) {
    assert.deepEqual((await execute(await register(mode, true))).value, { password: 'new' })
    assert.equal(await targetPage.locator('input').inputValue(), 'old')
  }
  const concurrent = await Promise.all([register('concurrent-a', true), register('concurrent-b', true)])
  const results = await Promise.all(concurrent.map((id, index) => execute(id, `new-${index}`)))
  assert.deepEqual(results.map(result => result.value), [{ password: 'new-0' }, { password: 'new-1' }])
  assert(!received.some(item => ['/stale', '/controlled', '/multipart', '/multipart-xhr', '/multipart-beacon', '/concurrent-a', '/concurrent-b'].includes(item.url)))
  assert.deepEqual((await execute(await register('prerequisite', true))).value, { password: 'new' })
  assert.equal(received.filter(item => item.url === '/key').length, 1)
  await assert.rejects(execute(await register('prerequisite-invalid', true)), /缺少目标字段/)
  await assert.rejects(execute(await register('prerequisite-unplanned', true)), /未授权请求/)
  assert(!received.some(item => item.url === '/unplanned' || item.method === 'POST' && item.url.startsWith('/prerequisite')))
  assert.equal((await controlPage.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).length, 0)
  const nonWritableId = await register('timer')
  await targetPage.evaluate(() => {
    globalThis.beforeIsolation = { fetch, setTimeout, sendBeacon: navigator.sendBeacon }
    Object.defineProperty(navigator, 'sendBeacon', { value: navigator.sendBeacon, writable: false, configurable: true })
  })
  await assert.rejects(execute(nonWritableId), /不能隔离页面边界/)
  assert(await targetPage.evaluate(() => {
    const restored = fetch === globalThis.beforeIsolation.fetch && setTimeout === globalThis.beforeIsolation.setTimeout
    Object.defineProperty(navigator, 'sendBeacon', { value: globalThis.beforeIsolation.sendBeacon, writable: true, configurable: true })
    return restored
  }))
  assert.equal((await controlPage.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).length, 0)

  // A strict arrow listener in a one-line script must resolve by its exact function location.
  await targetPage.addScriptTag({ content: `document.querySelector('form').addEventListener('submit', e => { 'use strict'; e.preventDefault(); fetch('/strict', { method: 'POST', body: 'cipher' }) }); document.querySelector('form').addEventListener('submit', e => { 'use strict'; e.preventDefault() });` })
  await request('deep.capture.start', { matcher: { kind: 'request', urlPattern: '/strict' } })
  const submit = targetPage.locator('form button').click({ noWaitAfter: true, timeout: 20_000 })
  const paused = await waitFor(controlPage, 'deep.capture.status', target, value => value.state === 'paused' && !value.pause.collecting)
  const resolved = paused.pause.frames.filter(frame => frame.functionInspection?.resolution === 'event-listener')
  assert.equal(resolved.length, 1, JSON.stringify(paused.pause))
  assert(resolved[0].functionInspection.resolved)
  await request('deep.capture.resume')
  await submit
  const nativeFormId = await register('native-form')
  const blockedForm = targetPage.waitForEvent('requestfailed', { predicate: request => request.url().endsWith('/native-form'), timeout: 10_000 })
  void blockedForm.catch(() => undefined)
  let nativeFormError
  await assert.rejects(execute(nativeFormId), error => { nativeFormError = error.message; return true })
  const failedForm = await blockedForm.catch(error => { throw new Error(`${error.message}; execution=${nativeFormError}; url=${targetPage.url()}; received=${JSON.stringify(received)}`) })
  assert(failedForm.failure().errorText.includes('BLOCKED_BY_CLIENT'))
  assert(!received.some(item => item.url === '/native-form'))
  console.log('Capture regressions passed: Request body, native network guard, timer cleanup, fresh input, controlled forms, multipart, concurrent callables, strict same-line listeners.')
} finally {
  await harness?.close()
  await new Promise(resolve => server.close(resolve))
}
