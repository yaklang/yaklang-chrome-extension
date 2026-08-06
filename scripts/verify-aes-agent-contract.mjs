import {
  extensionRequest,
  launchBrowserAgentContractHarness,
  transformedFetchOptions,
} from './browser-agent-contract-harness.mjs'

const targetURL = process.env.AES_TARGET || 'http://127.0.0.1:82/'
const plaintext = {username: 'admin', password: '123456'}
let harness

try {
  harness = await launchBrowserAgentContractHarness({
    profilePrefix: 'yakit-aes-contract-',
    targetURL,
  })
  const {controlPage, tabId, targetPage} = harness
  let browserRequestCount = 0
  targetPage.on('request', (request) => {
    if (new URL(request.url()).pathname === '/encrypt/aes.php') browserRequestCount += 1
  })

  await extensionRequest(controlPage, 'recording.start', {
    tabId,
    frameId: 0,
    captureValues: true,
    maxEntries: 120,
    maxValueBytes: 8_192,
  })
  await targetPage.locator('#username').fill('admin')
  await targetPage.locator('#password').fill('wrong-password')
  await targetPage.getByRole('button', {name: '登录', exact: true}).click()
  await targetPage.getByRole('button', {name: 'AES固定Key', exact: true}).click()
  await targetPage.waitForTimeout(500)
  if (browserRequestCount !== 1) {
    throw new Error(`Initial AES recording expected one real request, received ${browserRequestCount}`)
  }

  const snapshot = await extensionRequest(
    controlPage,
    'recording.get',
    {tabId, frameId: 0, limit: 120},
  )
  const candidate = snapshot.profileCandidates?.find((item) => (
    item.status === 'ready'
      && new URL(item.request?.url, targetURL).pathname === '/encrypt/aes.php'
      && item.source?.callHandleId
  ))
  if (!candidate) {
    throw new Error(`Single-call AES candidate was not ready after one recording: ${JSON.stringify(snapshot)}`)
  }

  const callable = await extensionRequest(controlPage, 'callable.create', {
    tabId,
    frameId: 0,
    source: 'recording',
    callHandleId: candidate.source.callHandleId,
    name: 'CryptoJS AES recorded call',
  })
  if (callable.kind !== 'recorded-call') {
    throw new Error(`AES callable was not retained from the recording: ${JSON.stringify(callable)}`)
  }

  const plainPacket = {
    method: 'POST',
    url: new URL('/encrypt/aes.php', targetURL).toString(),
    headers: [{name: 'Content-Type', value: 'application/json'}],
    bodyBase64: Buffer.from(JSON.stringify(plaintext)).toString('base64'),
  }
  const proposal = await extensionRequest(controlPage, 'analysis.profile.propose', {
    tabId,
    frameId: 0,
    candidateId: candidate.id,
    callableId: callable.id,
    inputPaths: ['body'],
    name: 'AES deterministic contract',
  })
  if (proposal?.proposal?.compiler !== 'browser-transform-guided-v1') {
    throw new Error(`AES Profile was not deterministically compiled: ${JSON.stringify(proposal)}`)
  }

  const validation = await extensionRequest(controlPage, 'analysis.profile.validate', {
    tabId,
    frameId: 0,
    candidateId: candidate.id,
    callableId: callable.id,
    inputPaths: ['body'],
    name: 'AES deterministic contract',
    packet: plainPacket,
    comparisonMode: 'structure',
  })
  if (!validation?.valid || !validation?.saveEligible
    || validation.proofLevel !== 'structure'
    || validation.validationDraft?.contractVersion !== 1) {
    throw new Error(`AES Profile validation failed: ${JSON.stringify(validation)}`)
  }
  if (browserRequestCount !== 1) {
    throw new Error(`AES Profile validation leaked a real browser request; observed ${browserRequestCount}`)
  }

  const validationDraft = await extensionRequest(
    controlPage,
    'analysis.profile.validation.latest',
    {tabId, frameId: 0},
  )
  if (!validationDraft || validationDraft.id !== validation.validationDraft.id
    || validationDraft.contractVersion !== 1 || validationDraft.profile?.id) {
    throw new Error(`AES Yakit handoff draft is invalid: ${JSON.stringify(validationDraft)}`)
  }
  const savedProfile = await extensionRequest(
    controlPage,
    'transform.profile.save',
    validationDraft.profile,
  )
  const execution = await extensionRequest(controlPage, 'transform.execute', {
    profileId: savedProfile.id,
    direction: 'request',
    packet: plainPacket,
  })
  const wireBody = Buffer.from(execution.bodyBase64, 'base64').toString('utf8')
  const form = new URLSearchParams(wireBody)
  const encryptedData = form.get('encryptedData')
  if (!encryptedData || encryptedData.startsWith('{') || form.size !== 1) {
    throw new Error(`AES Profile produced an invalid or nested form envelope: ${wireBody}`)
  }
  if (browserRequestCount !== 1) {
    throw new Error(`Saved AES Profile leaked a real browser request; observed ${browserRequestCount}`)
  }

  const response = await fetch(
    execution.url,
    transformedFetchOptions(execution, plainPacket.headers),
  )
  const result = await response.json()
  if (!result.success) throw new Error(`Target server rejected the AES Profile output: ${JSON.stringify(result)}`)
  process.stdout.write(
    'AES Agent contract verified: one recording produced a callable, deterministic Profile, Yakit confirmation draft, and server-accepted wire request.\n',
  )
} finally {
  await harness?.close()
}
