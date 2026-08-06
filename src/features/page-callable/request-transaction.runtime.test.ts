import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserPageCallableTransaction } from '@/types/models'
import { executeRequestTransaction } from './request-transaction'

const KEY_URL = 'http://127.0.0.1:82/encrypt/server_generate_key.php'
const FINAL_URL = 'http://127.0.0.1:82/encrypt/aesserver.php'

const transaction: BrowserPageCallableTransaction = {
  version: 2,
  prerequisites: [{
    boundary: 'fetch',
    method: 'GET',
    url: KEY_URL,
    requestBodyFormat: 'none',
    maxRequestBodyBytes: 16 * 1_024,
    response: {
      statusCode: 200,
      url: KEY_URL,
      bodyFormat: 'json',
      maxBodyBytes: 64 * 1_024,
      requiredPaths: ['body.aes_key', 'body.aes_iv'],
    },
  }],
  request: {
    boundary: 'fetch',
    method: 'POST',
    url: FINAL_URL,
    expectedDestinations: ['body.encryptedData'],
    bodyFormat: 'json',
  },
  inputMode: 'auto',
}

const replacedGlobals = new Map<string, PropertyDescriptor | undefined>()

function replaceGlobal(name: string, value: unknown): void {
  if (!replacedGlobals.has(name)) replacedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

function response(url: string, body: unknown): Response {
  const result = new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
  Object.defineProperty(result, 'url', { value: url, configurable: true })
  return result
}

function installPageRuntime(fetch: typeof globalThis.fetch): void {
  class FakeXMLHttpRequest {
    open(): void {}
    setRequestHeader(): void {}
    send(): void {}
  }
  class FakeHTMLFormElement {
    submit(): void {}
    requestSubmit(): void {}
  }
  const pageWindow = {
    fetch,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    alert: () => undefined,
    confirm: () => false,
    prompt: () => null,
    open: () => null,
  }
  replaceGlobal('window', pageWindow)
  replaceGlobal('location', { href: 'http://127.0.0.1:82/' })
  replaceGlobal('document', {
    documentElement: null,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })
  replaceGlobal('navigator', {})
  replaceGlobal('XMLHttpRequest', FakeXMLHttpRequest)
  replaceGlobal('HTMLFormElement', FakeHTMLFormElement)
  replaceGlobal('HTMLButtonElement', class FakeHTMLButtonElement {})
  replaceGlobal('HTMLInputElement', class FakeHTMLInputElement {})
}

afterEach(() => {
  for (const [name, descriptor] of replacedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete (globalThis as Record<string, unknown>)[name]
  }
  replacedGlobals.clear()
})

describe('request transaction runtime', () => {
  it('executes a proven prerequisite and captures the terminal request without sending it', async () => {
    const network: string[] = []
    installPageRuntime(async (request) => {
      const url = request instanceof Request ? request.url : String(request)
      network.push(url)
      return response(url, { aes_key: 'dynamic-key', aes_iv: 'dynamic-iv' })
    })

    const result = await executeRequestTransaction({
      transaction,
      logicalInput: { username: 'admin', password: '123456' },
      timeoutMs: 1_000,
      invoke: async () => {
        const keyResponse = await window.fetch(KEY_URL)
        const key = await keyResponse.json() as { aes_key: string; aes_iv: string }
        await window.fetch(FINAL_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ encryptedData: `${key.aes_key}:${key.aes_iv}:ciphertext` }),
        })
      },
    })

    expect(result).toEqual({ encryptedData: 'dynamic-key:dynamic-iv:ciphertext' })
    expect(network).toEqual([KEY_URL])
  })

  it('fails closed before the network when the page requests an unproven prerequisite', async () => {
    const network: string[] = []
    installPageRuntime(async (request) => {
      network.push(request instanceof Request ? request.url : String(request))
      return response(KEY_URL, { aes_key: 'dynamic-key', aes_iv: 'dynamic-iv' })
    })

    await expect(executeRequestTransaction({
      transaction,
      logicalInput: {},
      timeoutMs: 1_000,
      invoke: async () => {
        await window.fetch('http://127.0.0.1:82/unrelated')
      },
    })).rejects.toThrow('页面尝试访问未授权请求 GET http://127.0.0.1:82/unrelated')
    expect(network).toEqual([])
  })

  it('rejects a prerequisite response that does not contain the proven dynamic inputs', async () => {
    installPageRuntime(async () => response(KEY_URL, { value: 'not-a-key-envelope' }))

    await expect(executeRequestTransaction({
      transaction,
      logicalInput: {},
      timeoutMs: 1_000,
      invoke: async () => {
        await window.fetch(KEY_URL)
      },
    })).rejects.toThrow('缺少目标字段：body.aes_key、body.aes_iv')
  })
})
