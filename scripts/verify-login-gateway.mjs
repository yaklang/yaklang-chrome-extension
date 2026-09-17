import assert from 'node:assert/strict'
import { createDecipheriv } from 'node:crypto'
import { extensionRequest, launchBrowserAgentContractHarness, transformedFetchOptions, waitFor } from './browser-agent-contract-harness.mjs'

const targetURL = process.env.LOGIN_TARGET || 'http://localhost:8080/crypto/sqli/aes-ecb/encrypt/login'
function decrypt(envelope) {
  const decipher = createDecipheriv('aes-128-cbc', Buffer.from(envelope.key, 'hex'), Buffer.from(envelope.iv, 'hex'))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.message, 'base64')), decipher.final()]).toString())
}
let harness
try {
  harness = await launchBrowserAgentContractHarness({ profilePrefix: 'yakit-login-gateway-', targetURL })
  const { targetPage, controlPage, tabId, extensionId } = harness
  const target = { tabId, frameId: 0 }
  let completedPosts = 0
  let blockedPosts = 0
  targetPage.on('response', response => { if (response.url() === targetURL && response.request().method() === 'POST') completedPosts++ })
  targetPage.on('requestfailed', request => {
    if (request.url() === targetURL && request.method() === 'POST' && request.failure()?.errorText.includes('BLOCKED_BY_CLIENT')) blockedPosts++
  })
  await extensionRequest(controlPage, 'recording.start', { ...target, captureValues: true, maxEntries: 300, maxValueBytes: 8192 })
  await targetPage.locator('#username').fill('audit-original')
  await targetPage.locator('#password').fill('original-wrong-password')
  await targetPage.locator('button[type=submit]').click()
  const recorded = await waitFor(controlPage, 'recording.get', target, snapshot =>
    snapshot.profileCandidates.some(candidate => candidate.direction === 'response' && candidate.status === 'ready'))
  await extensionRequest(controlPage, 'recording.stop', target)
  assert.equal(completedPosts, 1)
  const responseCandidate = recorded.profileCandidates.find(candidate => candidate.direction === 'response' && candidate.status === 'ready')
  const requestCandidate = recorded.profileCandidates.find(candidate => candidate.direction === 'request' && candidate.transactionId === responseCandidate.transactionId)
  assert.equal(requestCandidate.status, 'capture-required', JSON.stringify(recorded.profileCandidates))

  await controlPage.goto(`chrome-extension://${extensionId}/options.html?tabId=${tabId}#gateway`)
  await controlPage.evaluate(() => {
    globalThis.captureActions = []
    const send = chrome.runtime.sendMessage.bind(chrome.runtime)
    chrome.runtime.sendMessage = (...args) => { globalThis.captureActions.push(args[0]); return send(...args) }
  })
  const traceIndex = recorded.traces.findIndex(trace => trace.id === responseCandidate.traceId)
  await controlPage.locator('.recording-traces button').nth(traceIndex).click()
  await controlPage.locator(`[data-event-id="${responseCandidate.source.eventId}"]`).click()
  await controlPage.getByRole('button', { name: '继续捕获请求方向', exact: true }).click()
  await waitFor(controlPage, 'deep.capture.status', target, status => status.state === 'armed')
  let submitError
  const submit = targetPage.locator('button[type=submit]').click({ noWaitAfter: true, timeout: 45_000 }).catch(error => { submitError = error })
  let profiles
  try {
    profiles = await waitFor(controlPage, 'transform.profile.list', {}, values => values.some(profile => profile.request.enabled && profile.response.enabled), 30_000)
  } catch (error) {
    const status = await extensionRequest(controlPage, 'deep.capture.status', target)
    if (status.pause) status.pause.frames = status.pause.frames.map(({ scopes, ...frame }) => frame)
    const actions = await controlPage.evaluate(() => globalThis.captureActions.filter(item => /create|start|save/.test(item.action)))
    throw new Error(`${error.message}\n${JSON.stringify(status)}\n${JSON.stringify(actions)}\n${await controlPage.locator('body').innerText()}`)
  }
  await submit
  if (submitError) throw submitError
  assert.equal(completedPosts, 1, 'the capture submission must not reach the server')
  assert.equal(blockedPosts, 1, 'the browser must confirm cancellation of the capture submission')
  const profile = profiles.find(value => value.request.enabled && value.response.enabled)
  assert.equal(profiles.length, 1, 'both directions must share one gateway')

  for (const plaintext of [
    { username: 'audit-new-user', password: 'new-wrong-password' },
    { username: 'audit-second-user', password: 'second-wrong-password' },
  ]) {
    const packet = { method: 'POST', url: targetURL, headers: [{ name: 'Content-Type', value: 'application/json' }], bodyBase64: Buffer.from(JSON.stringify(plaintext)).toString('base64') }
    const encrypted = await extensionRequest(controlPage, 'transform.execute', { profileId: profile.id, direction: 'request', packet })
    const envelope = JSON.parse(Buffer.from(encrypted.bodyBase64, 'base64').toString())
    assert.deepEqual(decrypt(envelope), plaintext, 'the complete new input must be encrypted')
    const response = await fetch(targetURL, transformedFetchOptions(encrypted, packet.headers))
    const wireResponse = await response.text()
    const decrypted = await extensionRequest(controlPage, 'transform.execute', {
      profileId: profile.id, direction: 'response', packet: { ...packet, bodyBase64: Buffer.from(wireResponse).toString('base64') },
    })
    assert.deepEqual(JSON.parse(Buffer.from(decrypted.bodyBase64, 'base64').toString()), decrypt(JSON.parse(wireResponse)))
  }
  assert.equal(completedPosts, 1, 'local gateway replay must not send browser requests')
  assert.equal(await targetPage.locator('#username').inputValue(), 'audit-original')
  assert.equal(await targetPage.locator('#password').inputValue(), 'original-wrong-password')
  // Also pause inside the native Fetch boundary, where changing window.fetch is too late.
  await extensionRequest(controlPage, 'deep.capture.start', {
    ...target, matcher: { kind: 'request', urlPattern: targetURL, frameHints: requestCandidate.capturePlan.frameHints },
  })
  const boundaryBlocked = targetPage.waitForEvent('requestfailed', {
    predicate: request => request.url() === targetURL && request.failure()?.errorText.includes('BLOCKED_BY_CLIENT'),
    timeout: 30_000,
  })
  void boundaryBlocked.catch(() => undefined)
  const boundarySubmit = targetPage.locator('button[type=submit]').click({ noWaitAfter: true, timeout: 30_000 }).catch(error => { submitError = error })
  const paused = await waitFor(controlPage, 'deep.capture.status', target, status => status.state === 'paused' && !status.pause.collecting)
  assert.equal(paused.pause.automaticCapture.state, 'ready')
  const boundaryCallable = await extensionRequest(controlPage, 'callable.create', {
    ...target, source: 'deep-capture', strategy: 'request-transaction',
    callFrameId: paused.pause.automaticCapture.frameId, candidateId: requestCandidate.id,
  })
  await boundarySubmit
  await boundaryBlocked
  if (submitError) throw submitError
  assert.equal(completedPosts, 1)
  assert.equal(blockedPosts, 2)
  await extensionRequest(controlPage, 'callable.delete', { ...target, callableId: boundaryCallable.id })
  console.log('Login gateway passed: one recording, automatic request capture, browser-confirmed cancellation, one bidirectional profile, two distinct plaintexts and real server response decryption.')
} finally { await harness?.close() }
