import {
  extensionRequest,
  launchBrowserAgentContractHarness,
  transformedFetchOptions,
  waitFor,
} from './browser-agent-contract-harness.mjs'

const targetURL = process.env.DES_TARGET || 'http://127.0.0.1:82/'
const requestPath = '/encrypt/des.php'
const plaintext = {username: 'admin', password: '123456'}
let harness

function pathOf(url) {
  return new URL(url, targetURL).pathname
}

async function performLogin(targetPage, password = 'wrong-password') {
  await targetPage.locator('#username').fill('admin')
  await targetPage.locator('#password').fill(password)
  await targetPage.getByRole('button', {name: '登录', exact: true}).click()
  return targetPage.getByRole('button', {name: 'Des规律Key', exact: true})
}

try {
  harness = await launchBrowserAgentContractHarness({
    profilePrefix: 'yakit-des-',
    targetURL,
  })
  const {controlPage, tabId, targetPage} = harness
  let browserRequestCount = 0
  targetPage.on('request', (request) => {
    if (pathOf(request.url()) === requestPath) browserRequestCount += 1
  })

  await extensionRequest(controlPage, 'recording.start', {
    tabId, frameId: 0, captureValues: true, maxEntries: 120, maxValueBytes: 8_192,
  })
  await (await performLogin(targetPage)).click()
  await targetPage.waitForTimeout(500)
  if (browserRequestCount !== 1) throw new Error(`Initial DES recording expected one request, received ${browserRequestCount}`)

  const snapshot = await extensionRequest(controlPage, 'recording.get', {tabId, frameId: 0, limit: 120})
  const candidate = snapshot.profileCandidates?.find((item) => pathOf(item.request?.url || '') === requestPath)
  if (!candidate || candidate.status !== 'capture-required') {
    throw new Error(`Structured DES output was not routed through business-envelope capture: ${JSON.stringify(candidate)}`)
  }
  const matcherEvent = snapshot.events?.find((event) => event.id === candidate.capturePlan?.matcherEventId)
  if (matcherEvent?.crypto?.family !== 'symmetric'
    || !matcherEvent.crypto.operation.toLowerCase().includes('des')
    || !matcherEvent.wrapperHandleId) {
    throw new Error(`DES candidate has no reusable crypto matcher: ${JSON.stringify(matcherEvent)}`)
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
  const replayButton = await performLogin(targetPage)
  let replayFailure
  const replay = replayButton.click({noWaitAfter: true, timeout: 20_000})
    .catch((reason) => { replayFailure = reason })
  const paused = await waitFor(controlPage, 'deep.capture.status', {tabId, frameId: 0}, (value) => (
    value?.state === 'paused' && value.pause?.collecting !== true
  ), 20_000)
  const automatic = paused.pause?.automaticCapture
  const frame = paused.pause?.frames?.find((item) => item.id === automatic?.frameId)
  if (automatic?.state !== 'ready' || automatic.strategy !== 'request-transaction'
    || frame?.functionName !== 'encryptAndSendDataDES') {
    throw new Error(`DES deep capture did not select its business request envelope: ${JSON.stringify({automatic, frame})}`)
  }
  const callable = await extensionRequest(controlPage, 'callable.create', {
    tabId,
    frameId: 0,
    source: 'deep-capture',
    strategy: 'request-transaction',
    callFrameId: frame.id,
    name: 'DES 请求事务',
    candidateId: candidate.id,
  })
  await replay
  if (replayFailure) throw replayFailure
  await targetPage.waitForTimeout(250)
  if (browserRequestCount !== 1) throw new Error(`DES capture leaked a terminal request; observed ${browserRequestCount}`)

  const callableExecution = await extensionRequest(controlPage, 'callable.execute', {
    tabId, frameId: 0, callableId: callable.id, args: [plaintext],
  })
  if (callableExecution.value?.username !== plaintext.username
    || !/^[a-f0-9]+$/i.test(callableExecution.value?.password || '')) {
    throw new Error(`DES request transaction did not preserve the Hex envelope: ${JSON.stringify(callableExecution)}`)
  }

  const plainPacket = {
    method: 'POST',
    url: new URL(requestPath, targetURL).toString(),
    headers: [{name: 'Content-Type', value: 'application/json'}],
    bodyBase64: Buffer.from(JSON.stringify(plaintext)).toString('base64'),
  }
  const validation = await extensionRequest(controlPage, 'analysis.profile.validate', {
    tabId,
    frameId: 0,
    candidateId: candidate.id,
    callableId: callable.id,
    inputPaths: ['body'],
    name: 'DES 明文网关',
    packet: plainPacket,
    comparisonMode: 'structure',
  })
  if (!validation?.valid || !validation?.saveEligible || !validation.validationDraft?.id) {
    throw new Error(`DES Profile validation failed: ${JSON.stringify(validation)}`)
  }
  const validationDraft = await extensionRequest(controlPage, 'analysis.profile.validation.latest', {tabId, frameId: 0})
  const savedProfile = await extensionRequest(controlPage, 'transform.profile.save', validationDraft.profile)
  const explanationText = JSON.stringify(savedProfile.explanation)
  if (!explanationText.includes('DES') || explanationText.includes(plaintext.password)) {
    throw new Error(`DES semantic explanation is missing or persisted plaintext: ${explanationText}`)
  }

  const execution = await extensionRequest(controlPage, 'transform.execute', {
    profileId: savedProfile.id,
    direction: 'request',
    packet: plainPacket,
  })
  const wireBody = JSON.parse(Buffer.from(execution.bodyBase64, 'base64').toString('utf8'))
  if (wireBody.username !== plaintext.username || !/^[a-f0-9]+$/i.test(wireBody.password || '')) {
    throw new Error(`Saved DES Profile produced an invalid terminal body: ${JSON.stringify(wireBody)}`)
  }
  if (!execution.nodeTrace?.length || !execution.fieldChanges?.some((change) => change.path === 'body.password')) {
    throw new Error(`Saved DES Profile did not return an explainable runtime trace: ${JSON.stringify(execution)}`)
  }
  if (browserRequestCount !== 1) throw new Error(`DES Profile execution leaked a browser request; observed ${browserRequestCount}`)

  const response = await fetch(execution.url, transformedFetchOptions(execution, plainPacket.headers))
  const result = await response.json()
  if (!result.success) throw new Error(`Target server rejected the saved DES Profile output: ${JSON.stringify(result)}`)
  process.stdout.write('DES transaction verified: the structured CipherParams result required business-envelope capture, replay preserved Hex serialization, runtime evidence stayed value-free, and the target accepted the final packet.\n')
} finally {
  await harness?.close()
}
