import type { BrowserPageCallableExecutionPolicy, BrowserPageCallableTransaction } from '@/types/models'
import { callableExecutionPolicy, settleCallableResult } from './execution'

const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_CONTROLS = 2_000
const MAX_FIELDS = 64
const MAX_MUTATIONS = 2_000
const DEFAULT_TIMEOUT_MS = 4_000

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
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
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

export function requestMatchesTransaction(
  transaction: BrowserPageCallableTransaction,
  method: string,
  url: string,
  baseUrl = runtimeBaseUrl(),
): boolean {
  return transaction.request.method.toUpperCase() === method.toUpperCase()
    && comparableUrl(transaction.request.url, baseUrl) === comparableUrl(url, baseUrl)
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

function parseForm(value: string): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>
  for (const [key, item] of new URLSearchParams(value)) {
    const previous = output[key]
    output[key] = previous === undefined ? item : Array.isArray(previous) ? [...previous, item] : [previous, item]
  }
  return output
}

function capturedBody(request: CapturedRequest): unknown {
  const contentType = request.headers['content-type']?.toLowerCase() || ''
  if (contentType.includes('application/json') || /^[\s\n\r]*[\[{]/.test(request.bodyText)) {
    try { return JSON.parse(request.bodyText) as unknown } catch { throw error('页面生成的请求 Body 不是有效 JSON') }
  }
  if (contentType.includes('application/x-www-form-urlencoded')) return parseForm(request.bodyText)
  return request.bodyText
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
    control.value = value === undefined || value === null ? ''
      : typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
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
    candidates.forEach((control) => setControlValue(control, field.value))
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
        if (snapshot.value !== undefined) snapshot.control.value = snapshot.value
        if (snapshot.checked !== undefined) snapshot.control.checked = snapshot.checked
        if (snapshot.selectedIndex !== undefined) snapshot.control.selectedIndex = snapshot.selectedIndex
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
    restorers.push(() => { target[key] = previous })
  } catch {
    // A non-writable optional boundary remains protected by the other installed boundaries.
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

export async function executeRequestTransaction(input: RequestTransactionInvocation): Promise<unknown> {
  const timeoutMs = callableExecutionPolicy('auto', input.timeoutMs ?? DEFAULT_TIMEOUT_MS).timeoutMs
  const rollback = beginDomRollback()
  const restorers: Array<() => void> = []
  let captured: CapturedRequest | undefined
  let captureFailure: Error | undefined
  let resolveCapture!: () => void
  const captureSignal = new Promise<void>((resolve) => { resolveCapture = resolve })

  const capture = async (request: CapturedRequest): Promise<void> => {
    if (captured || captureFailure) {
      captureFailure = error('页面流程产生了多个网络请求，无法唯一确定转换边界')
      resolveCapture()
      throw captureFailure
    }
    if (!requestMatchesTransaction(input.transaction, request.method, request.url)) {
      captureFailure = error(`页面尝试访问未授权请求 ${request.method} ${request.url}`)
      resolveCapture()
      throw captureFailure
    }
    if (byteLength(request.bodyText) > MAX_BODY_BYTES) {
      captureFailure = error('页面生成的请求 Body 超过 8 MiB')
      resolveCapture()
      throw captureFailure
    }
    captured = request
    resolveCapture()
  }

  const previousFetch = window.fetch
  setMethod(window, 'fetch', (async function transactionFetch(requestInput: RequestInfo | URL, init?: RequestInit) {
    const request = new Request(requestInput, init)
    await capture({
      boundary: 'fetch',
      method: request.method.toUpperCase(),
      url: request.url,
      headers: headerRecord(request.headers),
      bodyText: await request.clone().text(),
    })
    return new Response(JSON.stringify({ success: false, error: 'request captured by Yakit Browser Agent' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
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
    void bodyText(body).then((text) => capture({ boundary: 'xhr', ...metadata, bodyText: text })).catch((reason) => {
      captureFailure = reason instanceof Error ? reason : error(String(reason))
      resolveCapture()
    })
  }) as typeof previousSend, restorers)

  if (typeof navigator.sendBeacon === 'function') {
    setMethod(navigator, 'sendBeacon', (function transactionBeacon(url: string | URL, data?: BodyInit | null) {
      void bodyText(data).then((text) => capture({
        boundary: 'beacon', method: 'POST', url: absoluteUrl(String(url)), headers: {}, bodyText: text,
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
  try {
    const domInputCount = bindLogicalInput(input.logicalInput)
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
        if (!captured && !captureFailure) captureFailure = error('等待页面生成目标请求超时')
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
    const value = capturedBody(captured)
    validateRequestTransactionOutput(value, input.transaction.request.expectedDestinations)
    return value
  } finally {
    for (const restore of restorers.reverse()) {
      try { restore() } catch { /* The document may have been replaced while fail-closing. */ }
    }
    rollback.finish()
  }
}

export async function executeSideEffectFreeCallable(
  invoke: () => unknown,
  execution: BrowserPageCallableExecutionPolicy,
): Promise<unknown> {
  const rollback = beginDomRollback()
  const restorers: Array<() => void> = []
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
  try {
    const value = await settleCallableResult(invoke(), execution)
    await Promise.resolve()
    if (attemptedBoundary) throw error(`普通页面函数尝试触发 ${attemptedBoundary}，必须改用请求事务`)
    const mutationCount = rollback.finish()
    if (mutationCount) throw error('普通页面函数修改了页面 DOM，必须改用请求事务')
    return value
  } finally {
    for (const restore of restorers.reverse()) {
      try { restore() } catch { /* The document may have been replaced while fail-closing. */ }
    }
    rollback.finish()
  }
}
