import {
  extensionRequest,
  launchBrowserAgentContractHarness,
  transformedFetchOptions,
  waitFor,
} from './browser-agent-contract-harness.mjs'

const targetURL = process.env.AESRSA_TARGET || 'http://127.0.0.1:82/'
let harness

try {
  harness = await launchBrowserAgentContractHarness({
    profilePrefix: 'yakit-aesrsa-',
    targetURL,
  })
  const {controlPage, tabId, targetPage} = harness
  let browserRequestCount = 0
  targetPage.on('request', (request) => {
    if (new URL(request.url()).pathname === '/encrypt/aesrsa.php') browserRequestCount += 1
  })

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
    candidateId: candidate.id,
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

  const plaintext = { username: 'admin', password: '123456' }
  let execution
  try {
    execution = await extensionRequest(controlPage, 'callable.execute', {
      tabId,
      frameId: 0,
      callableId: callable.id,
      args: [plaintext],
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
  try {
    await extensionRequest(controlPage, 'callable.execute', {
      tabId,
      frameId: 0,
      callableId: callable.id,
      args: [plaintext],
    })
  } catch (reason) {
    throw new Error(
      `Captured request transaction is not repeatable: ${reason instanceof Error ? reason.message : String(reason)}`,
    )
  }

  const plainPacket = {
    method: 'POST',
    url: new URL('/encrypt/aesrsa.php', targetURL).toString(),
    headers: [{ name: 'Content-Type', value: 'application/json' }],
    bodyBase64: Buffer.from(JSON.stringify(plaintext)).toString('base64'),
  }
  const proposal = await extensionRequest(controlPage, 'analysis.profile.propose', {
    tabId,
    frameId: 0,
    candidateId: candidate.id,
    callableId: callable.id,
    inputPaths: ['body'],
    name: 'AES+RSA deterministic contract',
  })
  if (proposal?.proposal?.compiler !== 'browser-transform-guided-v1'
    || proposal?.profile?.request?.enabled !== true) {
    throw new Error(`Deterministic profile proposal was not compiled: ${JSON.stringify(proposal)}`)
  }

  let validation
  try {
    validation = await extensionRequest(controlPage, 'analysis.profile.validate', {
      tabId,
      frameId: 0,
      candidateId: candidate.id,
      callableId: callable.id,
      inputPaths: ['body'],
      name: 'AES+RSA deterministic contract',
      packet: plainPacket,
      comparisonMode: 'structure',
    })
  } catch (reason) {
    throw new Error(
      `Deterministic profile validation could not execute: ${reason instanceof Error ? reason.message : String(reason)}; `
      + `packet=${JSON.stringify(plainPacket)}; profile=${JSON.stringify(proposal.profile)}`,
    )
  }
  if (!validation?.valid || !validation?.saveEligible
    || validation.proofLevel !== 'structure'
    || validation.validationDraft?.contractVersion !== 1
    || !validation.validationDraft?.id) {
    throw new Error(`Deterministic profile validation failed: ${JSON.stringify(validation)}`)
  }
  if (browserRequestCount !== 1) {
    throw new Error(`Profile validation leaked a real browser request; observed ${browserRequestCount}`)
  }

  const validationDraft = await extensionRequest(
    controlPage,
    'analysis.profile.validation.latest',
    { tabId, frameId: 0 },
  )
  if (!validationDraft || validationDraft.contractVersion !== 1
    || validationDraft.id !== validation.validationDraft.id
    || validationDraft.profile?.id) {
    throw new Error(`Yakit handoff draft is missing or already persisted: ${JSON.stringify(validationDraft)}`)
  }

  const savedProfile = await extensionRequest(
    controlPage,
    'transform.profile.save',
    validationDraft.profile,
  )
  const profiles = await extensionRequest(controlPage, 'transform.profile.list', { tabId, frameId: 0 })
  if (!savedProfile?.id || !profiles.some((profile) => profile.id === savedProfile.id)) {
    throw new Error(`Confirmed profile was not persisted: ${JSON.stringify({ savedProfile, profiles })}`)
  }

  const profileExecution = await extensionRequest(controlPage, 'transform.execute', {
    profileId: savedProfile.id,
    direction: 'request',
    packet: plainPacket,
  })
  const transformedEnvelope = JSON.parse(
    Buffer.from(profileExecution.bodyBase64, 'base64').toString('utf8'),
  )
  for (const field of ['encryptedData', 'encryptedKey', 'encryptedIv']) {
    if (typeof transformedEnvelope?.[field] !== 'string' || !transformedEnvelope[field]) {
      throw new Error(`Saved profile output is missing ${field}: ${JSON.stringify(profileExecution)}`)
    }
  }
  if (browserRequestCount !== 1) {
    throw new Error(`Saved profile execution leaked a real browser request; observed ${browserRequestCount}`)
  }

  const response = await fetch(
    profileExecution.url,
    transformedFetchOptions(profileExecution, plainPacket.headers),
  )
  const result = await response.json()
  if (!result.success) throw new Error(`Target server rejected the saved Profile output: ${JSON.stringify(result)}`)

  await targetPage.reload()
  const staleProfile = await waitFor(
    controlPage,
    'transform.profile.list',
    { tabId, frameId: 0 },
    (items) => items?.find((item) => item.id === savedProfile.id)?.recovery?.state === 'stale',
    10_000,
  ).then((items) => items.find((item) => item.id === savedProfile.id))
  if (staleProfile.enabled || staleProfile.recovery?.capture?.automatic !== true) {
    throw new Error(`Reloaded Profile did not fail closed with an automatic Recovery Plan: ${JSON.stringify(staleProfile)}`)
  }

  await extensionRequest(controlPage, 'transform.recovery.start', { id: savedProfile.id })
  await targetPage.locator('#username').fill('admin')
  await targetPage.locator('#password').fill('wrong-password')
  await targetPage.getByRole('button', { name: '登录', exact: true }).click()
  let recoveryClickFailure
  const recoveryClick = targetPage.getByRole('button', { name: 'AES+Rsa加密', exact: true })
    .click({ noWaitAfter: true, timeout: 20_000 })
    .catch((reason) => { recoveryClickFailure = reason })
  const recoveryPause = await waitFor(controlPage, 'deep.capture.status', {
    tabId, frameId: 0,
  }, (value) => value?.state === 'paused' && value.pause?.collecting !== true, 20_000)
  const recoveryAutomatic = recoveryPause.pause?.automaticCapture
  if (recoveryAutomatic?.state !== 'ready' || !recoveryAutomatic.frameId
    || recoveryAutomatic.strategy !== 'request-transaction') {
    throw new Error(`Recovery Plan did not locate the request transaction: ${JSON.stringify(recoveryPause)}`)
  }
  const recovery = await extensionRequest(controlPage, 'transform.recovery.capture', {
    id: savedProfile.id,
    ...recoveryPause.target,
    callFrameId: recoveryAutomatic.frameId,
    strategy: recoveryAutomatic.strategy,
  })
  await recoveryClick
  if (recoveryClickFailure) throw recoveryClickFailure
  if (recovery.state !== 'validation-required' || !recovery.pending?.callableId) {
    throw new Error(`Recovery capture was not staged for validation: ${JSON.stringify(recovery)}`)
  }
  const recoveryValidation = await extensionRequest(controlPage, 'transform.recovery.validate', {
    id: savedProfile.id,
    packet: plainPacket,
  })
  if (recoveryValidation.recovery?.state !== 'confirmation-required'
    || !recoveryValidation.recovery.validation?.id) {
    throw new Error(`Recovered Profile did not require explicit confirmation: ${JSON.stringify(recoveryValidation)}`)
  }
  const recoveredProfile = await extensionRequest(controlPage, 'transform.recovery.confirm', {
    id: savedProfile.id,
    validationId: recoveryValidation.recovery.validation.id,
  })
  if (recoveredProfile.id !== savedProfile.id || recoveredProfile.recovery?.state !== 'ready'
    || recoveredProfile.target.documentId === savedProfile.target.documentId) {
    throw new Error(`Recovery confirmation did not atomically replace the document binding: ${JSON.stringify(recoveredProfile)}`)
  }
  const recoveredExecution = await extensionRequest(controlPage, 'transform.execute', {
    profileId: recoveredProfile.id,
    direction: 'request',
    packet: plainPacket,
  })
  const recoveredResponse = await fetch(
    recoveredExecution.url,
    transformedFetchOptions(recoveredExecution, plainPacket.headers),
  )
  const recoveredResult = await recoveredResponse.json()
  if (!recoveredResult.success) {
    throw new Error(`Target server rejected the recovered Profile output: ${JSON.stringify(recoveredResult)}`)
  }
  process.stdout.write(
    'AES+RSA Agent contract verified: evidence compiled, validated, saved, reloaded stale, recovered through one request-boundary capture, revalidated, explicitly confirmed, and accepted by the target server.\n',
  )
} finally {
  await harness?.close()
}
