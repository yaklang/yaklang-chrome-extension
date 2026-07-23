import { describe, expect, it } from 'vitest'
import type { BrowserPageCallableTransaction } from '@/types/models'
import { requestMatchesTransaction, validateRequestTransactionOutput } from './request-transaction'

const transaction: BrowserPageCallableTransaction = {
  request: {
    method: 'POST',
    url: 'encrypt/aesrsa.php?mode=login',
    expectedDestinations: ['body.encryptedData', 'body.encryptedKey', 'body.encryptedIv'],
  },
  inputMode: 'auto',
  boundaries: ['fetch', 'xhr', 'beacon', 'form'],
}

describe('request transaction contract', () => {
  it('matches a relative recorded URL against the exact page request', () => {
    expect(requestMatchesTransaction(
      transaction,
      'post',
      'http://127.0.0.1:82/login/encrypt/aesrsa.php?mode=login',
      'http://127.0.0.1:82/login/index.html',
    )).toBe(true)
  })

  it('rejects another method, origin, path, or query', () => {
    const base = 'http://127.0.0.1:82/'
    expect(requestMatchesTransaction(transaction, 'GET', transaction.request.url, base)).toBe(false)
    expect(requestMatchesTransaction(transaction, 'POST', 'https://example.test/encrypt/aesrsa.php?mode=login', base)).toBe(false)
    expect(requestMatchesTransaction(transaction, 'POST', '/encrypt/rsa.php?mode=login', base)).toBe(false)
    expect(requestMatchesTransaction(transaction, 'POST', '/encrypt/aesrsa.php?mode=other', base)).toBe(false)
  })

  it('accepts a complete multi-field envelope and fails closed on a missing field', () => {
    const envelope = {
      encryptedData: 'ciphertext',
      encryptedKey: 'wrapped-key',
      encryptedIv: 'wrapped-iv',
    }
    expect(() => validateRequestTransactionOutput(envelope, transaction.request.expectedDestinations)).not.toThrow()
    expect(() => validateRequestTransactionOutput(
      {...envelope, encryptedIv: undefined},
      transaction.request.expectedDestinations,
    )).toThrow('截获的请求缺少目标字段：body.encryptedIv')
  })
})
