/** Exact external xAI OAuth responses; the shipped provider and Host authorization remain real. */
const DEVICE_URL = 'https://auth.x.ai/oauth2/device/code'
const TOKEN_URL = 'https://auth.x.ai/oauth2/token'

export const XAI_VERIFICATION_URL = 'https://auth.x.ai/device?user_code=WXYZ-1234'
export const XAI_USER_CODE = 'WXYZ-1234'
export const XAI_ACCESS_TOKEN = 'browser-fixture-xai-access'

/**
 * Intercept only xAI's external device endpoints until the owning browser scenario closes.
 * @returns explicit approval, observed request counts, and restoration of the original fetch.
 */
export function installXaiOAuthFixture() {
  const originalFetch = globalThis.fetch
  let approve: (() => void) | undefined
  let deviceRequests = 0
  let tokenRequests = 0
  let cancelledRequests = 0
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url !== DEVICE_URL && url !== TOKEN_URL) return originalFetch(input, init)
    if (init?.method !== 'POST') throw new Error('xAI OAuth fixture requires POST')
    if (url === DEVICE_URL) {
      deviceRequests += 1
      return Response.json({
        device_code: 'fixture-private-device-code', user_code: XAI_USER_CODE,
        verification_uri: 'https://auth.x.ai/device', verification_uri_complete: XAI_VERIFICATION_URL,
        expires_in: 600, interval: 0.01,
      })
    }
    tokenRequests += 1
    if (!(init.body instanceof URLSearchParams)) throw new Error('xAI OAuth fixture requires form fields')
    const fields = init.body
    if (fields.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:device_code'
      || fields.get('device_code') !== 'fixture-private-device-code') {
      throw new Error('Unexpected xAI OAuth token request')
    }
    const signal = init.signal
    if (signal === undefined || signal === null) throw new Error('xAI token polling requires cancellation')
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener('abort', abort)
        approve = undefined
        resolve()
      }
      const abort = () => {
        cancelledRequests += 1
        signal.removeEventListener('abort', abort)
        approve = undefined
        reject(new DOMException('Fixture device polling cancelled', 'AbortError'))
      }
      approve = finish
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    return Response.json({
      access_token: XAI_ACCESS_TOKEN, refresh_token: 'browser-fixture-xai-refresh', expires_in: 3600,
    })
  }
  return {
    approve() {
      if (approve === undefined) throw new Error('No xAI token request is pending')
      approve()
    },
    counts: () => ({ deviceRequests, tokenRequests, cancelledRequests }),
    restore() { globalThis.fetch = originalFetch },
  }
}
