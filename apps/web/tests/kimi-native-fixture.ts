/** Exact external Kimi response for the real pi-ai adapter; unrelated external fetches are refused. */
export const KIMI_MESSAGES_URL = 'https://api.kimi.com/coding/v1/messages?beta=true'
export const KIMI_NATIVE_KEY = 'browser-fixture-kimi-native-key'
export const KIMI_REPLY = 'Native Kimi request accepted.'

/**
 * Install a bounded provider response without replacing adapter or authorization behavior.
 * @returns observed requests, unexpected external URLs, and a fetch restoration callback.
 */
export function installKimiNativeFixture() {
  const originalFetch = globalThis.fetch
  const requests: { url: string; method: string; key: string | null; body: unknown }[] = []
  const unexpected: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url !== KIMI_MESSAGES_URL) {
      const parsed = new URL(url)
      if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]') {
        return originalFetch(input, init)
      }
      unexpected.push(url)
      throw new Error(`Native-auth fixture refuses external request: ${url}`)
    }
    const request = new Request(input, init)
    requests.push({ url, method: request.method, key: request.headers.get('x-api-key'), body: await request.json() })
    if (request.method !== 'POST' || request.headers.get('x-api-key') !== KIMI_NATIVE_KEY) {
      throw new Error('Kimi fixture requires POST with the provider-native API key')
    }
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'msg_native_fixture', type: 'message', role: 'assistant', model: 'kimi-for-coding',
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: KIMI_REPLY } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })
  }
  return {
    requests,
    unexpected,
    restore() { globalThis.fetch = originalFetch },
  }
}
