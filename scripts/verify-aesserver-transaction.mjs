import {
  extensionRequest,
  launchBrowserAgentContractHarness,
  transformedFetchOptions,
  waitFor,
} from './browser-agent-contract-harness.mjs'

const targetURL = process.env.AESSERVER_TARGET || 'http://127.0.0.1:82/'
const keyPath = '/encrypt/server_generate_key.php'
const requestPath = '/encrypt/aesserver.php'
const plaintext = {username: 'admin', password: '123456'}
let harness

function pathOf(url) {
  return new URL(url, targetURL).pathname
}

function snapshotSummary(snapshot) {
  return {
    events: snapshot.events?.map((event) => ({
      sequence: event.sequence,
      kind: event.kind,
      operation: event.operation,
      url: event.url ? pathOf(event.url) : undefined,
    })),
    candidates: snapshot.profileCandidates?.map((candidate) => ({
      status: candidate.status,
      request: pathOf(candidate.request?.url || ''),
      prerequisites: candidate.capturePlan?.transaction?.prerequisites?.map((step) => pathOf(step.url)),
    })),
  }
}

function dependencySummary(snapshot, candidate) {
  const eventIds = new Set(candidate.evidence?.flatMap((item) => item.eventIds || []))
  return {
    evidence: candidate.evidence?.filter((item) => item.kind === 'response-boundary'),
    events: snapshot.events?.filter((event) => eventIds.has(event.id)).map((event) => ({
      id: event.id,
      sequence: event.sequence,
      kind: event.kind,
      operation: event.operation,
      inputs: event.inputs?.map((item) => item.path),
      outputs: event.outputs?.map((item) => item.path),
    })),
    links: snapshot.links?.filter((link) => eventIds.has(link.fromEventId) || eventIds.has(link.toEventId))
      .map((link) => ({kind: link.kind, fromPath: link.fromPath, toPath: link.toPath})),
  }
}

async function performLogin(targetPage, password = 'wrong-password') {
  await targetPage.locator('#username').fill('admin')
  await targetPage.locator('#password').fill(password)
  await targetPage.getByRole('button', {name: '登录', exact: true}).click()
  return targetPage.getByRole('button', {name: 'AES服务端获取Key', exact: true})
}

try {
  harness = await launchBrowserAgentContractHarness({
    profilePrefix: 'yakit-aesserver-',
    targetURL,
  })
  const {controlPage, tabId, targetPage} = harness
  const observed = {key: 0, terminal: 0}
  targetPage.on('request', (request) => {
    const path = pathOf(request.url())
    if (path === keyPath) observed.key += 1
    if (path === requestPath) observed.terminal += 1
  })

  await extensionRequest(controlPage, 'recording.start', {
    tabId,
    frameId: 0,
    captureValues: true,
    maxEntries: 160,
    maxValueBytes: 8_192,
  })
  await (await performLogin(targetPage)).click()
  await targetPage.waitForTimeout(600)
  if (observed.key !== 1 || observed.terminal !== 1) {
    throw new Error(`Initial operation did not produce the expected two-request flow: ${JSON.stringify(observed)}`)
  }

  const snapshot = await extensionRequest(
    controlPage,
    'recording.get',
    {tabId, frameId: 0, limit: 160},
  )
  const candidate = snapshot.profileCandidates?.find((item) => (
    item.status === 'capture-required'
      && pathOf(item.request?.url || '') === requestPath
      && item.capturePlan?.transaction?.prerequisites?.some((step) => pathOf(step.url) === keyPath)
  ))
  if (!candidate) {
    throw new Error(`Recording did not infer the online key dependency: ${JSON.stringify(snapshotSummary(snapshot))}`)
  }
  const transaction = candidate.capturePlan.transaction
  if (transaction.version !== 2
    || transaction.prerequisites.length !== 1
    || transaction.prerequisites[0].boundary !== 'fetch'
    || transaction.prerequisites[0].response.bodyFormat !== 'json'
    || !transaction.prerequisites[0].response.requiredPaths.includes('body.aes_key')
    || !transaction.prerequisites[0].response.requiredPaths.includes('body.aes_iv')
    || transaction.request.boundary !== 'fetch'
    || pathOf(transaction.request.url) !== requestPath) {
    throw new Error(`Inferred request transaction is not evidence-complete: ${JSON.stringify({
      transaction,
      dependency: dependencySummary(snapshot, candidate),
    })}`)
  }

  const matcherEvent = snapshot.events?.find((event) => event.id === candidate.capturePlan.matcherEventId)
  if (!matcherEvent?.crypto?.adapterId || !matcherEvent.wrapperHandleId) {
    throw new Error(`Online-key candidate has no deep-capture matcher: ${JSON.stringify(candidate)}`)
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
  const paused = await waitFor(
    controlPage,
    'deep.capture.status',
    {tabId, frameId: 0},
    (value) => value?.state === 'paused' && value.pause?.collecting !== true,
    20_000,
  )
  const automatic = paused.pause?.automaticCapture
  const frame = paused.pause?.frames?.find((item) => item.id === automatic?.frameId)
  if (automatic?.state !== 'ready'
    || automatic.strategy !== 'request-transaction'
    || frame?.functionName !== 'fetchAndSendDataAes') {
    throw new Error(`Deep capture selected an invalid strategy: ${JSON.stringify({automatic, functionName: frame?.functionName})}`)
  }
  const callable = await extensionRequest(controlPage, 'callable.create', {
    tabId,
    frameId: 0,
    source: 'deep-capture',
    strategy: 'request-transaction',
    callFrameId: frame.id,
    name: '在线取钥请求事务',
    candidateId: candidate.id,
  })
  await replay
  if (replayFailure) throw replayFailure
  await targetPage.waitForTimeout(300)
  if (observed.key !== 2 || observed.terminal !== 1) {
    throw new Error(`Deep capture did not preserve the prerequisite/terminal boundary: ${JSON.stringify(observed)}`)
  }

  const beforeCallable = {...observed}
  const callableExecution = await extensionRequest(controlPage, 'callable.execute', {
    tabId,
    frameId: 0,
    callableId: callable.id,
    args: [plaintext],
  })
  if (typeof callableExecution.value?.encryptedData !== 'string') {
    throw new Error(`Request transaction did not return the terminal envelope: ${JSON.stringify(callableExecution)}`)
  }
  if (observed.key !== beforeCallable.key + 1 || observed.terminal !== beforeCallable.terminal) {
    throw new Error(`Callable execution leaked or skipped a request: ${JSON.stringify({beforeCallable, observed})}`)
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
    name: '在线取钥明文网关',
    packet: plainPacket,
    comparisonMode: 'structure',
  })
  if (!validation?.valid || !validation?.saveEligible || !validation.validationDraft?.id) {
    throw new Error(`Online-key Profile validation failed: ${JSON.stringify({
      valid: validation?.valid,
      saveEligible: validation?.saveEligible,
      proofLevel: validation?.proofLevel,
    })}`)
  }
  const validationDraft = await extensionRequest(
    controlPage,
    'analysis.profile.validation.latest',
    {tabId, frameId: 0},
  )
  if (!validationDraft?.profile || validationDraft.id !== validation.validationDraft.id) {
    throw new Error('Validated online-key Profile draft was not available for confirmation')
  }
  const savedProfile = await extensionRequest(
    controlPage,
    'transform.profile.save',
    validationDraft.profile,
  )
  if (
    savedProfile.requestTransaction?.callableId !== callable.id
    || savedProfile.requestTransaction?.transaction?.version !== 2
  ) {
    throw new Error('Saved Profile did not retain its trusted request-transaction binding')
  }

  const beforeProfile = {...observed}
  const execution = await extensionRequest(controlPage, 'transform.execute', {
    profileId: savedProfile.id,
    direction: 'request',
    packet: plainPacket,
  })
  if (observed.key !== beforeProfile.key + 1 || observed.terminal !== beforeProfile.terminal) {
    throw new Error(`Saved Profile leaked or skipped a request: ${JSON.stringify({beforeProfile, observed})}`)
  }
  const sessionHeader = execution.setHeaders?.find((header) => header.name.toLowerCase() === 'cookie')
  if (!sessionHeader?.value.includes('PHPSESSID=')) {
    throw new Error(`Saved Profile did not bind the browser session to the outgoing packet: ${JSON.stringify(execution)}`)
  }
  const wireBody = JSON.parse(Buffer.from(execution.bodyBase64, 'base64').toString('utf8'))
  if (typeof wireBody.encryptedData !== 'string' || Object.keys(wireBody).length !== 1) {
    throw new Error(`Saved Profile produced an invalid terminal envelope: ${JSON.stringify(wireBody)}`)
  }

  const response = await fetch(
    execution.url,
    transformedFetchOptions(execution, plainPacket.headers),
  )
  const result = await response.json()
  if (!result.success) {
    throw new Error(`Target server rejected the session-bound Profile output: ${JSON.stringify(result)}`)
  }
  process.stdout.write(
    'Online-key transaction verified: evidence inferred one bounded prerequisite, the browser sent no terminal request during replay, the saved Profile exported its browser session, and the target server accepted the final packet.\n',
  )
} finally {
  await harness?.close()
}
