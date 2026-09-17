import type { BrowserPageCallableExecutionPolicy, BrowserPageCallableTransaction } from '@/types/models'
import { callableExecutionPolicy, settleCallableResult } from './execution'
import { readRequestBody } from '@/shared/request-body'

const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_CONTROLS = 2_000
const MAX_FIELDS = 64
const MAX_MUTATIONS = 2_000
const DEFAULT_TIMEOUT_MS = 4_000
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis)
let executionQueue: Promise<unknown> = Promise.resolve()
let observeInput: ((value: unknown) => void) | undefined

export function observeCallableInput(value: unknown): void { observeInput?.(value) }

export function serializePageExecution<T>(run: () => Promise<T>): Promise<T> {
  const result = executionQueue.then(run, run)
  executionQueue = result.catch(() => undefined)
  return result
}

interface CapturedRequest {
  boundary: 'fetch' | 'xhr' | 'beacon' | 'form'
  method: string
  url: string
  headers: Record<string, string>
  bodyText: string
}

interface TransactionContext {
  domInputCount: number
}

export interface RequestTransactionInvocation {
  transaction: BrowserPageCallableTransaction
  logicalInput: unknown
  invoke(context: TransactionContext): unknown
  timeoutMs?: number
  observeInputs?(): () => void
}

interface RollbackController {
  finish(): number
}

interface MutableControl extends Element {
  value?: string
  checked?: boolean
  selectedIndex?: number
  name?: string
  id: string
  type?: string
}

function error(message: string): Error {
  return new Error(`请求事务失败：${message}`)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => nativeSetTimeout(resolve, milliseconds))
}

function absoluteUrl(value: string): string {
  try { return new URL(value, location.href).toString() } catch { return value }
}

function runtimeBaseUrl(): string {
  return typeof location === 'undefined' ? 'http://localhost/' : location.href
}

function comparableUrl(value: string, baseUrl: string): string {
  try {
    const url = new URL(value, baseUrl)
    return `${url.origin}${url.pathname}${url.search}`
  } catch {
    return value
  }
}

export function resolveRequestTransactionFetchInput(
  input: RequestInfo | URL,
  baseUrl = runtimeBaseUrl(),
): RequestInfo | URL {
  if (typeof Request !== 'undefined' && input instanceof Request) return input
  try { return new URL(String(input), baseUrl).toString() } catch { return input }
}

export function requestMatchesTransaction(
  transaction: BrowserPageCallableTransaction,
  method: string,
  url: string,
  baseUrl = runtimeBaseUrl(),
): boolean {
  return transaction.request.method.toUpperCase() === method.toUpperCase()
    && comparableUrl(transaction.request.url, baseUrl) === comparableUrl(url, baseUrl)
}

function requestMatchesStep(
  step: { boundary: CapturedRequest['boundary']; method: string; url: string },
  request: CapturedRequest,
  baseUrl = runtimeBaseUrl(),
): boolean {
  return step.boundary === request.boundary
    && step.method.toUpperCase() === request.method.toUpperCase()
    && comparableUrl(step.url, baseUrl) === comparableUrl(request.url, baseUrl)
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

async function bodyText(value: unknown): Promise<string> {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) return value.toString()
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value.text()
  if (typeof FormData !== 'undefined' && value instanceof FormData) {
    const form = new URLSearchParams()
    for (const [key, item] of value.entries()) {
      if (typeof item !== 'string') throw error(`表单字段 ${key} 包含文件，暂不允许自动回放`)
      form.append(key, item)
    }
    return form.toString()
  }
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value))
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  throw error(`不支持的请求 Body 类型 ${Object.prototype.toString.call(value)}`)
}

function headerRecord(headers: Headers): Record<string, string> {
  const output: Record<string, string> = Object.create(null) as Record<string, string>
  headers.forEach((value, key) => { output[key.toLowerCase()] = value })
  return output
}

function normalizedBodyHeaders(body: unknown, headers: Record<string, string>): Record<string, string> {
  if (body instanceof FormData) return { ...headers, 'content-type': 'application/x-www-form-urlencoded' }
  if (headers['content-type']) return headers
  if (body instanceof URLSearchParams) return { ...headers, 'content-type': 'application/x-www-form-urlencoded' }
  if (body instanceof Blob && body.type) return { ...headers, 'content-type': body.type }
  return headers
}

function parseForm(value: string): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>
  for (const [key, item] of new URLSearchParams(value)) {
    const previous = output[key]
    output[key] = previous === undefined ? item : Array.isArray(previous) ? [...previous, item] : [previous, item]
  }
  return output
}

function capturedBodyFormat(request: CapturedRequest): BrowserPageCallableTransaction['request']['bodyFormat'] {
  const contentType = request.headers['content-type']?.toLowerCase() || ''
  if (contentType.includes('application/x-www-form-urlencoded')) return 'form'
  if (contentType.includes('application/json') || /^[\s\n\r]*[\[{]/.test(request.bodyText)) return 'json'
  return 'raw'
}

function capturedBody(request: CapturedRequest): unknown {
  const format = capturedBodyFormat(request)
  if (format === 'json') {
    try { return JSON.parse(request.bodyText) as unknown } catch { throw error('页面生成的请求 Body 不是有效 JSON') }
  }
  if (format === 'form') return parseForm(request.bodyText)
  return request.bodyText
}

function bodyValue(text: string, format: BrowserPageCallableTransaction['request']['bodyFormat']): unknown {
  if (format === 'json') {
    try { return JSON.parse(text) as unknown } catch { throw error('在线前置请求返回的 Body 不是有效 JSON') }
  }
  if (format === 'form') return parseForm(text)
  return text
}

function validatePrerequisiteRequest(
  step: BrowserPageCallableTransaction['prerequisites'][number],
  request: CapturedRequest,
): void {
  const length = byteLength(request.bodyText)
  if (length > step.maxRequestBodyBytes) {
    throw error(`在线前置请求 Body 超过计划上限 ${step.maxRequestBodyBytes} B`)
  }
  if (step.requestBodyFormat === 'none') {
    if (length !== 0) throw error('在线前置请求意外携带了 Body')
    return
  }
  const actual = capturedBodyFormat(request)
  if (actual !== step.requestBodyFormat) {
    throw error(`在线前置请求生成了 ${actual} Body，但录制证据要求 ${step.requestBodyFormat} Body`)
  }
}

async function readBoundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw error(`在线前置响应超过计划上限 ${maximumBytes} B`)
  }
  const clone = response.clone()
  if (!clone.body) return ''
  const reader = clone.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      if (!result.value) continue
      length += result.value.byteLength
      if (length > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw error(`在线前置响应超过计划上限 ${maximumBytes} B`)
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

async function validatePrerequisiteResponse(
  step: BrowserPageCallableTransaction['prerequisites'][number],
  response: Response,
): Promise<void> {
  if (response.status !== step.response.statusCode) {
    throw error(`在线前置响应状态为 ${response.status}，录制证据要求 ${step.response.statusCode}`)
  }
  if (comparableUrl(response.url, runtimeBaseUrl()) !== comparableUrl(step.response.url, runtimeBaseUrl())) {
    throw error(`在线前置响应到达未计划 URL ${response.url || '(empty)'}`)
  }
  const text = await readBoundedResponseText(response, step.response.maxBodyBytes)
  const value = bodyValue(text, step.response.bodyFormat)
  validateRequestTransactionOutput(value, step.response.requiredPaths)
}

function readOwnPath(input: unknown, path: string): unknown {
  let current = input
  for (const segment of path.split('.').filter(Boolean)) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

export function validateRequestTransactionOutput(value: unknown, destinations: string[]): void {
  const missing = destinations.filter((destination) => {
    const path = destination === 'body' ? '' : destination.startsWith('body.') ? destination.slice(5) : destination
    return path ? readOwnPath(value, path) === undefined : value === undefined
  })
  if (missing.length) throw error(`截获的请求缺少目标字段：${missing.join('、')}`)
}

function logicalObject(value: unknown): Record<string, unknown> | undefined {
  let current = value
  if (typeof current === 'string') {
    try { current = JSON.parse(current) as unknown } catch { return undefined }
  }
  return current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, unknown>
    : undefined
}

interface LogicalField {
  path: string
  key: string
  value: unknown
}

function logicalFields(value: unknown): LogicalField[] {
  const root = logicalObject(value)
  if (!root) return []
  const output: LogicalField[] = []
  const visit = (current: Record<string, unknown>, prefix: string, depth: number) => {
    if (depth > 4 || output.length >= MAX_FIELDS) return
    for (const [key, item] of Object.entries(current)) {
      if (output.length >= MAX_FIELDS) break
      const path = prefix ? `${prefix}.${key}` : key
      if (item && typeof item === 'object' && !Array.isArray(item)) visit(item as Record<string, unknown>, path, depth + 1)
      else output.push({ path, key, value: item })
    }
  }
  visit(root, '', 0)
  return output
}

function controlNames(control: MutableControl): string[] {
  const name = typeof control.name === 'string' ? control.name : ''
  return [name, control.id, name.replace(/\[([^\]]+)\]/g, '.$1')].filter(Boolean)
}

function setControlValue(control: MutableControl, value: unknown): void {
  const type = String(control.type || '').toLowerCase()
  if ((type === 'checkbox' || type === 'radio') && typeof control.checked === 'boolean') {
    if (type === 'radio') control.checked = String(control.value ?? '') === String(value)
    else control.checked = typeof value === 'boolean' ? value : Array.isArray(value)
      ? value.map(String).includes(String(control.value ?? ''))
      : Boolean(value)
    return
  }
  if ('value' in control) {
    const text = value === undefined || value === null ? ''
      : typeof value === 'object' ? JSON.stringify(value) : String(value)
    let prototype = Object.getPrototypeOf(control)
    while (prototype && !Object.getOwnPropertyDescriptor(prototype, 'value')?.set) prototype = Object.getPrototypeOf(prototype)
    const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (setter) setter.call(control, text)
    else control.value = text
  }
}

function notifyControl(control: MutableControl): void {
  control.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  control.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
}

function bindLogicalInput(value: unknown): number {
  const fields = logicalFields(value)
  if (!fields.length) return 0
  const controls = [...document.querySelectorAll('input, textarea, select')].slice(0, MAX_CONTROLS) as MutableControl[]
  const missing: string[] = []
  let matched = 0
  for (const field of fields) {
    const candidates = controls.filter((control) => controlNames(control).some((name) => (
      name === field.path || name === field.key || name.endsWith(`.${field.path}`) || name.endsWith(`.${field.key}`)
    )))
    if (!candidates.length) {
      missing.push(field.path)
      continue
    }
    const owners = new Set(candidates.map((control) => control.closest('form') || document))
    if (owners.size > 1) throw error(`明文字段 ${field.path} 对应多个表单，不能猜测输入目标`)
    candidates.forEach((control) => { setControlValue(control, field.value); notifyControl(control) })
    matched += 1
  }
  if (matched && missing.length) throw error(`无法把明文字段映射到页面输入：${missing.join('、')}`)
  return matched
}

function beginDomRollback(): RollbackController {
  const controls = [...document.querySelectorAll('input, textarea, select')].slice(0, MAX_CONTROLS) as MutableControl[]
  const controlSnapshots = controls.map((control) => ({
    control,
    value: control.value,
    checked: control.checked,
    selectedIndex: control.selectedIndex,
  }))
  const mutations: MutationRecord[] = []
  const root = document.documentElement
  const observer = root && typeof MutationObserver !== 'undefined'
    ? new MutationObserver((records) => {
      if (mutations.length < MAX_MUTATIONS) mutations.push(...records.slice(0, MAX_MUTATIONS - mutations.length))
    })
    : undefined
  observer?.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
    characterData: true,
    characterDataOldValue: true,
  })
  let finished = false
  return {
    finish() {
      if (finished) return mutations.length
      finished = true
      if (observer) mutations.push(...observer.takeRecords().slice(0, Math.max(0, MAX_MUTATIONS - mutations.length)))
      observer?.disconnect()
      for (const snapshot of controlSnapshots) {
        const changed = snapshot.control.value !== snapshot.value || snapshot.control.checked !== snapshot.checked
        if (snapshot.value !== undefined) setControlValue(snapshot.control, snapshot.value)
        if (snapshot.checked !== undefined) snapshot.control.checked = snapshot.checked
        if (snapshot.selectedIndex !== undefined) snapshot.control.selectedIndex = snapshot.selectedIndex
        if (changed) notifyControl(snapshot.control)
      }
      for (const mutation of [...mutations].reverse()) {
        try {
          if (mutation.type === 'attributes') {
            if (!mutation.attributeName) continue
            if (mutation.oldValue === null) (mutation.target as Element).removeAttributeNS(mutation.attributeNamespace, mutation.attributeName)
            else (mutation.target as Element).setAttributeNS(mutation.attributeNamespace, mutation.attributeName, mutation.oldValue)
          } else if (mutation.type === 'characterData') {
            mutation.target.nodeValue = mutation.oldValue
          } else {
            mutation.addedNodes.forEach((node) => { if (node.parentNode === mutation.target) mutation.target.removeChild(node) })
            const before = mutation.nextSibling?.parentNode === mutation.target ? mutation.nextSibling : null
            mutation.removedNodes.forEach((node) => mutation.target.insertBefore(node, before))
          }
        } catch {
          // Best-effort rollback is followed by fail-closed validation at the request boundary.
        }
      }
      return mutations.length
    },
  }
}

function setMethod<T extends object, K extends keyof T>(target: T, key: K, value: T[K], restorers: Array<() => void>): void {
  const previous = target[key]
  try {
    target[key] = value
    if (target[key] !== value) throw new Error('属性不可写')
    restorers.push(() => { target[key] = previous })
  } catch (reason) {
    throw error(`不能隔离页面边界 ${String(key)}：${String(reason)}`)
  }
}

function formRequest(form: HTMLFormElement, submitter?: HTMLElement | null): CapturedRequest {
  const method = (form.method || 'GET').toUpperCase()
  const url = absoluteUrl(form.action || location.href)
  const formData = new FormData(form, submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement ? submitter : undefined)
  const encoded = new URLSearchParams()
  for (const [key, value] of formData.entries()) {
    if (typeof value !== 'string') throw error(`表单字段 ${key} 包含文件，暂不允许自动回放`)
    encoded.append(key, value)
  }
  return {
    boundary: 'form', method, url,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    bodyText: encoded.toString(),
  }
}

export function executeRequestTransaction(input: RequestTransactionInvocation): Promise<unknown> {
  return serializePageExecution(() => runRequestTransaction(input))
}

async function runRequestTransaction(input: RequestTransactionInvocation): Promise<unknown> {
  const timeoutMs = callableExecutionPolicy('auto', input.timeoutMs ?? DEFAULT_TIMEOUT_MS).timeoutMs
  const rollback = beginDomRollback()
  const restorers: Array<() => void> = []
  const transactionAbort = new AbortController()
  let cancelTasks: (() => void) | undefined
  let restoreObservation: (() => void) | undefined
  try {
    cancelTasks = trackInvocationTasks()
    restoreObservation = input.observeInputs?.()
    const fields = logicalFields(input.logicalInput)
    if (!fields.length) {
      let value = input.logicalInput
      if (typeof value === 'string') { try { value = JSON.parse(value) } catch { /* Raw plaintext. */ } }
      fields.push({ path: '', key: '', value })
    }
    const consumed = new Set<string>()
    observeInput = (value) => {
      if (value instanceof ArrayBuffer) value = new TextDecoder().decode(value)
      else if (ArrayBuffer.isView(value)) value = new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
      if (typeof value === 'string') {
        try { value = JSON.parse(value) } catch { /* Individual plaintext arguments are also supported. */ }
      }
      for (const field of fields) {
        const actual = value && typeof value === 'object' ? readOwnPath(value, field.path) : value
        try {
          if (JSON.stringify(actual) === JSON.stringify(field.value)) consumed.add(field.path)
        } catch { /* Opaque crypto values do not prove an input binding. */ }
      }
    }
    let captured: CapturedRequest | undefined
    let captureFailure: Error | undefined
    let prerequisiteIndex = 0
    let prerequisiteInFlight = false
    let resolveCapture!: () => void
    const captureSignal = new Promise<void>((resolve) => { resolveCapture = resolve })

    const fail = (reason: unknown): Error => {
      const message = reason instanceof Error ? reason.message : String(reason)
      const failure = reason instanceof Error && message.startsWith('请求事务失败：') ? reason : error(message)
      captureFailure = failure
      if (!transactionAbort.signal.aborted) transactionAbort.abort(failure)
      resolveCapture()
      return failure
    }

    const capture = async (request: CapturedRequest): Promise<void> => {
      if (captured || captureFailure) {
        throw fail('页面流程产生了目标请求之外的额外网络请求')
      }
      if (prerequisiteInFlight || prerequisiteIndex !== input.transaction.prerequisites.length) {
        throw fail('页面在在线前置请求完成前尝试生成最终业务请求')
      }
      if (!requestMatchesStep(input.transaction.request, request)) {
        throw fail(`页面尝试访问未授权请求 ${request.method} ${request.url}`)
      }
      if (byteLength(request.bodyText) > MAX_BODY_BYTES) {
        throw fail('页面生成的请求 Body 超过 8 MiB')
      }
      observeInput?.(capturedBody(request))
      const missing = fields.filter((field) => !consumed.has(field.path))
      if (missing.length) throw fail(`未证明新明文进入转换：${missing.map((field) => field.path || 'body').join('、')}；页面可能仍在使用旧状态`)
      captured = request
      resolveCapture()
    }

    const previousFetch = window.fetch
    setMethod(window, 'fetch', (async function transactionFetch(this: Window, requestInput: RequestInfo | URL, init?: RequestInit) {
      const request = new Request(resolveRequestTransactionFetchInput(requestInput), init)
      const body = await readRequestBody(request, MAX_BODY_BYTES)
      const observed: CapturedRequest = {
        boundary: 'fetch',
        method: request.method.toUpperCase(),
        url: request.url,
        headers: { ...headerRecord(request.headers), 'content-type': body.contentType },
        bodyText: body.text,
      }
      const prerequisite = input.transaction.prerequisites[prerequisiteIndex]
      if (prerequisite) {
        if (prerequisiteInFlight) throw fail('页面并发发起了多个在线前置请求，无法证明执行顺序')
        if (!requestMatchesStep(prerequisite, observed)) {
          throw fail(`页面尝试访问未授权请求 ${observed.method} ${observed.url}`)
        }
        let forwardAbort: (() => void) | undefined
        try {
          validatePrerequisiteRequest(prerequisite, observed)
          prerequisiteInFlight = true
          if (request.signal.aborted) transactionAbort.abort(request.signal.reason)
          else {
            forwardAbort = () => transactionAbort.abort(request.signal.reason)
            request.signal.addEventListener('abort', forwardAbort, { once: true })
          }
          const expectedRedirect = comparableUrl(prerequisite.url, runtimeBaseUrl())
            === comparableUrl(prerequisite.response.url, runtimeBaseUrl()) ? 'error' : 'follow'
          const guardedRequest = new Request(request, {
            redirect: expectedRedirect,
            signal: transactionAbort.signal,
          })
          const response = await Reflect.apply(previousFetch, this, [guardedRequest])
          await validatePrerequisiteResponse(prerequisite, response)
          prerequisiteIndex += 1
          return response
        } catch (reason) {
          throw fail(reason)
        } finally {
          if (forwardAbort) request.signal.removeEventListener('abort', forwardAbort)
          prerequisiteInFlight = false
        }
      }
      await capture(observed)
      return await new Promise<Response>(() => undefined)
    }) as typeof previousFetch, restorers)

    const xhrMetadata = new WeakMap<XMLHttpRequest, { method: string; url: string; headers: Record<string, string> }>()
    const xhrPrototype = XMLHttpRequest.prototype
    const previousOpen = xhrPrototype.open
    const previousSetHeader = xhrPrototype.setRequestHeader
    const previousSend = xhrPrototype.send
    setMethod(xhrPrototype, 'open', (function transactionOpen(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      xhrMetadata.set(this, { method: method.toUpperCase(), url: absoluteUrl(String(url)), headers: Object.create(null) as Record<string, string> })
      return Reflect.apply(previousOpen, this, [method, url, ...rest] as never)
    }) as typeof previousOpen, restorers)
    setMethod(xhrPrototype, 'setRequestHeader', (function transactionSetHeader(this: XMLHttpRequest, name: string, value: string) {
      const metadata = xhrMetadata.get(this)
      if (metadata) metadata.headers[name.toLowerCase()] = value
      return Reflect.apply(previousSetHeader, this, [name, value])
    }) as typeof previousSetHeader, restorers)
    setMethod(xhrPrototype, 'send', (function transactionSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const metadata = xhrMetadata.get(this)
      if (!metadata) throw error('XHR 没有可验证的 open 边界')
      void bodyText(body).then((text) => capture({ boundary: 'xhr', ...metadata,
        headers: normalizedBodyHeaders(body, metadata.headers), bodyText: text })).catch((reason) => {
        captureFailure = reason instanceof Error ? reason : error(String(reason))
        resolveCapture()
      })
    }) as typeof previousSend, restorers)

    if (typeof navigator.sendBeacon === 'function') {
      setMethod(navigator, 'sendBeacon', (function transactionBeacon(url: string | URL, data?: BodyInit | null) {
        void bodyText(data).then((text) => capture({
          boundary: 'beacon', method: 'POST', url: absoluteUrl(String(url)), headers: normalizedBodyHeaders(data, {}), bodyText: text,
        })).catch((reason) => {
          captureFailure = reason instanceof Error ? reason : error(String(reason))
          resolveCapture()
        })
        return true
      }) as typeof navigator.sendBeacon, restorers)
    }

    const formPrototype = HTMLFormElement.prototype
    const previousSubmit = formPrototype.submit
    const previousRequestSubmit = formPrototype.requestSubmit
    setMethod(formPrototype, 'submit', (function transactionSubmit(this: HTMLFormElement) {
      void capture(formRequest(this)).catch(() => undefined)
    }) as typeof previousSubmit, restorers)
    setMethod(formPrototype, 'requestSubmit', (function transactionRequestSubmit(this: HTMLFormElement, submitter?: HTMLElement | null) {
      void capture(formRequest(this, submitter)).catch(() => undefined)
    }) as typeof previousRequestSubmit, restorers)
    const submitListener = (event: SubmitEvent) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.target instanceof HTMLFormElement) void capture(formRequest(event.target, event.submitter)).catch(() => undefined)
    }
    document.addEventListener('submit', submitListener, true)
    restorers.push(() => document.removeEventListener('submit', submitListener, true))

    setMethod(window, 'alert', (() => undefined) as typeof window.alert, restorers)
    setMethod(window, 'confirm', (() => false) as typeof window.confirm, restorers)
    setMethod(window, 'prompt', (() => null) as typeof window.prompt, restorers)
    setMethod(window, 'open', (() => null) as typeof window.open, restorers)

    let invocationFailure: unknown
    let returned: unknown
    const domInputCount = bindLogicalInput(input.logicalInput)
    if (domInputCount) await delay(0)
    try { returned = input.invoke({ domInputCount }) } catch (reason) {
      invocationFailure = reason
      resolveCapture()
    }
    void Promise.resolve(returned).catch((reason) => {
      invocationFailure = reason
      if (!captured) resolveCapture()
    })
    await Promise.race([
      captureSignal,
      delay(timeoutMs).then(() => {
        if (!captured && !captureFailure) fail('等待页面完成在线依赖并生成目标请求超时')
      }),
    ])
    if (captureFailure) throw captureFailure
    if (!captured) {
      if (invocationFailure instanceof Error) throw error(invocationFailure.message)
      throw error('页面函数没有产生目标请求')
    }
    await delay(0)
    if (captureFailure) throw captureFailure
    if (invocationFailure instanceof Error) throw error(invocationFailure.message)
    const actualBodyFormat = capturedBodyFormat(captured)
    if (actualBodyFormat !== input.transaction.request.bodyFormat) {
      throw error(`页面生成了 ${actualBodyFormat} Body，但录制证据要求 ${input.transaction.request.bodyFormat} Body`)
    }
    const value = capturedBody(captured)
    validateRequestTransactionOutput(value, input.transaction.request.expectedDestinations)
    return value
  } finally {
    if (!transactionAbort.signal.aborted) transactionAbort.abort(error('请求事务已经结束'))
    try { rollback.finish() } finally {
      observeInput = undefined
      for (const restore of [restoreObservation, cancelTasks, ...restorers.reverse()]) {
        try { restore?.() } catch { /* The document may have been replaced while fail-closing. */ }
      }
    }
  }
}

export function executeSideEffectFreeCallable(
  invoke: () => unknown,
  execution: BrowserPageCallableExecutionPolicy,
): Promise<unknown> {
  return serializePageExecution(() => runSideEffectFreeCallable(invoke, execution))
}

async function runSideEffectFreeCallable(invoke: () => unknown, execution: BrowserPageCallableExecutionPolicy): Promise<unknown> {
  const rollback = beginDomRollback()
  let cancelTasks: (() => void) | undefined
  const restorers: Array<() => void> = []
  try {
    cancelTasks = trackInvocationTasks()
    let attemptedBoundary = ''
    const block = (boundary: string): never => {
      attemptedBoundary = boundary
      throw error(`普通页面函数尝试触发 ${boundary}，必须改用请求事务`)
    }
    setMethod(window, 'fetch', (() => block('Fetch')) as typeof window.fetch, restorers)
    setMethod(XMLHttpRequest.prototype, 'send', (function blockedXhrSend() { return block('XHR') }) as typeof XMLHttpRequest.prototype.send, restorers)
    if (typeof navigator.sendBeacon === 'function') {
      setMethod(navigator, 'sendBeacon', (() => block('Beacon')) as typeof navigator.sendBeacon, restorers)
    }
    setMethod(HTMLFormElement.prototype, 'submit', (function blockedSubmit() { return block('Form Submit') }) as typeof HTMLFormElement.prototype.submit, restorers)
    setMethod(HTMLFormElement.prototype, 'requestSubmit', (function blockedRequestSubmit() { return block('Form Submit') }) as typeof HTMLFormElement.prototype.requestSubmit, restorers)
    const submitListener = (event: SubmitEvent) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      attemptedBoundary = 'Form Submit'
    }
    document.addEventListener('submit', submitListener, true)
    restorers.push(() => document.removeEventListener('submit', submitListener, true))
    const value = await settleCallableResult(invoke(), execution)
    await Promise.resolve()
    if (attemptedBoundary) throw error(`普通页面函数尝试触发 ${attemptedBoundary}，必须改用请求事务`)
    const mutationCount = rollback.finish()
    if (mutationCount) throw error('普通页面函数修改了页面 DOM，必须改用请求事务')
    return value
  } finally {
    try { rollback.finish() } finally {
      cancelTasks?.()
      for (const restore of restorers.reverse()) {
        try { restore() } catch { /* The document may have been replaced while fail-closing. */ }
      }
    }
  }
}

function trackInvocationTasks(): () => void {
  const restorers: Array<() => void> = []
  const pending: Array<() => void> = []
  let active = true
  const cleanup = () => {
    active = false
    for (const action of [...pending, ...restorers.reverse()]) {
      try { action() } catch { /* Cleanup must attempt every installed hook. */ }
    }
  }
  try {
    for (const [schedule, cancel] of [
      ['setTimeout', 'clearTimeout'], ['setInterval', 'clearInterval'],
      ['requestAnimationFrame', 'cancelAnimationFrame'], ['requestIdleCallback', 'cancelIdleCallback'],
    ] as const) {
      const original = window[schedule] as Function | undefined
      const clear = window[cancel] as Function | undefined
      if (!original || !clear) continue
      setMethod(window, schedule, ((callback: unknown, ...args: unknown[]) => {
        if (typeof callback !== 'function') throw error('回放不支持字符串定时任务')
        const id = Reflect.apply(original, window, [(...values: unknown[]) => {
          if (active) Reflect.apply(callback, window, values)
        }, ...args])
        pending.push(() => Reflect.apply(clear, window, [id]))
        return id
      }) as never, restorers)
    }
  } catch (reason) { cleanup(); throw reason }
  return cleanup
}
