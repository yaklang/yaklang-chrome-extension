import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { createDecipheriv } from 'node:crypto'
import { extensionRequest, launchBrowserAgentContractHarness } from './browser-agent-contract-harness.mjs'

function body(packet) { return JSON.parse(packet.raw.slice(packet.raw.indexOf('\r\n\r\n') + 4)) }
function decrypt(envelope) {
  const decipher = createDecipheriv('aes-128-cbc', Buffer.from(envelope.key, 'hex'), Buffer.from(envelope.iv, 'hex'))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.message, 'base64')), decipher.final()]).toString())
}

const targetURL = process.env.LOGIN_TARGET || 'http://localhost:8080/crypto/sqli/aes-ecb/encrypt/login'
const engine = spawn('go', ['test', './common/yakgrpc', '-run', '^TestBrowserAgentLiveGateway$', '-count=1', '-v'], {
  cwd: process.env.YAKLANG_ROOT || resolve(import.meta.dirname, '../../../go/yaklang'),
  env: { ...process.env, YAK_BROWSER_AGENT_E2E: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
let harness, connection
const exited = new Promise(resolve => engine.once('exit', code => resolve(code)))
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Go Agent bridge startup timed out: ${output.slice(-4000)}`)), 120_000)
  engine.stdout.on('data', chunk => {
    output += chunk
    const match = output.match(/YAK_AGENT_E2E=(\{[^\n]+\})/)
    if (match) { clearTimeout(timer); resolve(JSON.parse(match[1])) }
  })
  engine.stderr.on('data', chunk => { output += chunk })
  engine.once('error', error => { clearTimeout(timer); reject(error) })
  engine.once('exit', code => { clearTimeout(timer); reject(new Error(`Go bridge exited ${code}: ${output}`)) })
})
try {
  connection = await ready
  const tool = async (name, params = {}) => {
    const response = await fetch(connection.endpoint, { method: 'POST', headers: { 'X-Test-Token': connection.token }, body: JSON.stringify({ tool: name, params }) })
    if (!response.ok) throw new Error(`${name}: ${await response.text()}`)
    return response.json()
  }
  harness = await launchBrowserAgentContractHarness({ profilePrefix: 'yakit-agent-gateway-', targetURL })
  const { controlPage, targetPage, tabId } = harness
  let completed = 0, blocked = 0
  targetPage.on('response', response => { if (response.url() === targetURL && response.request().method() === 'POST') completed++ })
  targetPage.on('requestfailed', request => { if (request.url() === targetURL && request.failure()?.errorText.includes('BLOCKED_BY_CLIENT')) blocked++ })
  const state = await controlPage.evaluate(async () => (await chrome.runtime.sendMessage({ action: 'state.get' })).data)
  await extensionRequest(controlPage, 'bridge.config.save', {
    transport: 'websocket', nativeHost: 'com.yaklang.browser_agent', endpoint: connection.bridge,
    autoConnect: false, installationId: state.bridge.installationId,
  })
  await controlPage.evaluate(async () => {
    const result = await chrome.runtime.sendMessage({ action: 'bridge.pair' })
    if (!result.ok) throw new Error(JSON.stringify(result.error))
  })
  for (let attempt = 0; ; attempt++) {
    const status = await controlPage.evaluate(async () => (await chrome.runtime.sendMessage({ action: 'bridge.status' })).data)
    if (status.state === 'connected') break
    if (attempt === 100) throw new Error(`Bridge did not connect: ${JSON.stringify(status)}`)
    await controlPage.waitForTimeout(100)
  }
  // Close the extension UI. All workflow calls below go through Go Agent tools.
  // A previously released human debugging session must not lock out the Agent.
  await extensionRequest(controlPage, 'deep.capture.start', { tabId, frameId: 0, matcher: { kind: 'request', urlPattern: '/not-triggered' } })
  await extensionRequest(controlPage, 'deep.capture.detach', { tabId, frameId: 0 })
  await controlPage.close()
  const call = (method, params = {}) => tool('browser.capability.call', { method, params: { tabId, frameId: 0, ...params } })
  const catalog = await tool('browser.capability.catalog', { domain: 'debugger' })
  assert(catalog.capabilities.some(item => item.method === 'browser.deep_capture.start'))
  const context = await call('browser.context', { includeDom: true })
  const nodes = context.document.interactive
  const username = nodes.find(node => node.name === 'username' || node.id === 'username')
  const password = nodes.find(node => node.name === 'password' || node.id === 'password')
  const submit = nodes.find(node => node.tag === 'button' && node.type === 'submit')
  assert(username && password && submit, JSON.stringify(nodes))
  for (const [node, value] of [[username, 'agent-original'], [password, 'agent-original-wrong']]) {
    await call('browser.node.action', { captureId: context.captureId, nodeId: node.nodeId, action: 'setValue', value })
  }
  const inspection = await tool('browser.crypto.inspect', { tabId, frameId: 0, captureId: context.captureId, nodeId: submit.nodeId })
  assert.equal(inspection.gatewayPreparation.state, 'capture-required')
  const plaintext = { username: 'agent-new-user', password: 'agent-new-wrong' }
  const url = new URL(targetURL)
  const request = `POST ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(plaintext)}`
  const prepareInput = { ...inspection.target, candidate_id: inspection.gatewayPreparation.candidateId, request, is_https: false }
  await assert.rejects(tool('browser.transform.prepare', { ...prepareInput, captureId: 'stale-context', nodeId: submit.nodeId }), /快照已经失效/)
  assert.equal((await call('browser.deep_capture.status')).state, 'detached', 'failed preparation must release its debugger')
  assert.equal(completed, 1)
  const prepared = await tool('browser.transform.prepare', prepareInput)
  assert(prepared.valid, JSON.stringify(prepared))
  assert.deepEqual(prepared.validationDraft.directions, { request: true, response: true })
  assert.equal(completed, 1, 'automatic preparation must not submit another real browser login')
  assert.equal(blocked, 1)
  const preparedAgain = await tool('browser.transform.prepare', prepareInput)
  assert(preparedAgain.valid)
  assert.equal(blocked, 1, 'repeated preparation must reuse existing captured functions')
  const tested = await tool('browser.http.test', { validation_id: preparedAgain.validationDraft.id, request, is_https: false })
  assert(tested.responseTransformEnabled, JSON.stringify(tested))
  assert(tested.requestTransformed, JSON.stringify(tested))
  assert(tested.responseTransformed)
  assert.deepEqual(decrypt(body(tested.wireRequest)), plaintext)
  assert.deepEqual(body(tested.plaintextResponse), decrypt(body(tested.wireResponse)))
  const draft = await call('browser.profile.validation.latest')
  const saved = await tool('browser.capability.call', { method: 'browser.transform.profile.save', params: draft.profile })
  assert(saved.request.enabled && saved.response.enabled)
  await tool('browser.capability.call', { method: 'browser.transform.profile.delete', params: { id: saved.id } })
  assert.equal(completed, 1)
  assert.equal(await targetPage.locator('#username').inputValue(), 'agent-original')
  assert.equal(await targetPage.locator('#password').inputValue(), 'agent-original-wrong')
  console.log('Agent gateway passed: signed Go bridge, advanced capability access, no plugin UI, failed-capture cleanup, automatic business capture, bidirectional validation, independently checked request/response crypto, default response decryption and Profile save/delete.')
} finally {
  await harness?.close()
  if (connection) await fetch(`${connection.endpoint}/finish`, { method: 'POST', headers: { 'X-Test-Token': connection.token } }).catch(() => undefined)
  else engine.kill('SIGTERM')
  const code = await exited
  if (code !== 0 && connection) throw new Error(`Go integration exited ${code}: ${output.slice(-4000)}`)
}
