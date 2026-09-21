import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Authorization from '@deepseek-ai/dsh-authorization'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { AuthorizationController } from '../src/authorization.ts'
import type { AuthorizationAttemptId, ProviderAuthorizationFrame } from '../src/types.ts'

const contexts: Context[] = []
const key = credentialKey('llm-pi-ai', 'openai-codex')

async function boot(run: (session: AuthorizationSession, ctx: Context) => Promise<void>) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(Authorization)
  await ctx.plugin(AuthorizationController)
  ctx.authorization.registerFlow({ key, label: 'Codex', methods: [{ id: 'oauth', label: 'ChatGPT' }], run: session => run(session, ctx) })
  return ctx
}

async function commit(ctx: Context) {
  await ctx.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: { accessToken: 'private-token' } }))
}

async function frame(iterator: AsyncIterator<ProviderAuthorizationFrame>) {
  const result = await iterator.next()
  expect(result.done).toBe(false)
  return result.value as ProviderAuthorizationFrame
}

afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

describe('caller-private provider authorization', () => {
  it('registers login as a Remote stream rather than a unary method', async () => {
    const ctx = await boot(async () => {})
    expect(remoteMethods(ctx.authorizationController)).toContainEqual({
      method: 'login', mode: 'stream', invocation: { kind: 'direct' },
    })
  })

  it('reports missing services and refuses scoped record keys', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AuthorizationController)
    expect(await ctx.authorizationController.describe('openai-codex')).toEqual({
      available: false, configured: false, nativeConfigured: false, writable: false, inFlight: false, methods: [],
    })
    await expect(ctx.authorizationController.describe('unrelated/openai-codex')).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(ctx.authorizationController.logout('openai-codex')).rejects.toMatchObject({ code: 'gateway/internal' })
  })

  it('projects provider-owned native checks without returning the checker or any secret', async () => {
    const ctx = await boot(async () => {})
    const nativeKey = credentialKey('llm-pi-ai', 'kimi-coding')
    let present = true
    const checkCredential = vi.fn(async () => present)
    ctx.authorization.registerFlow({ key: nativeKey, label: 'Kimi',
      methods: [{ id: 'oauth', label: 'Account' }, { id: 'api-key', label: 'API key' }],
      checkCredential, run: async () => {},
    })
    expect(await ctx.authorizationController.describe('kimi-coding')).toEqual({
      available: true, configured: false, nativeConfigured: true, writable: true, inFlight: false,
      methods: [{ id: 'oauth', label: 'Account' }, { id: 'api-key', label: 'API key' }],
    })
    present = false
    expect(await ctx.authorizationController.describe('kimi-coding')).toMatchObject({ nativeConfigured: false })
    expect(checkCredential).toHaveBeenCalledTimes(2)
    await ctx.credentials.modifyRecord(nativeKey, () => Promise.resolve({ kind: 'grant', payload: { token: 'private-native-token' } }))
    const stored = await ctx.authorizationController.describe('kimi-coding')
    expect(stored).toMatchObject({ configured: true, nativeConfigured: false })
    expect(checkCredential).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(stored)).not.toContain('private-native-token')
    expect(stored).not.toHaveProperty('checkCredential')
  })

  it.each([false, true])('does not invoke a retired checker after the record read: replacement %s', async (replace) => {
    const ctx = await boot(async () => {})
    const nativeKey = credentialKey('llm-pi-ai', 'checker-lifetime')
    const retired = vi.fn(async () => true)
    const replacement = vi.fn(async () => false)
    const remove = ctx.authorization.registerFlow({ key: nativeKey, label: 'Native',
      methods: [{ id: 'oauth', label: 'Account' }], checkCredential: retired, run: async () => {},
    })
    let release!: () => void
    let reading!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { reading = resolve })
    const original = ctx.credentials.describeRecord.bind(ctx.credentials)
    const read = vi.spyOn(ctx.credentials, 'describeRecord').mockImplementationOnce(async (key) => {
      reading()
      await gate
      return original(key)
    })
    const pending = ctx.authorizationController.describe('checker-lifetime')
    try {
      await entered
      remove()
      if (replace) ctx.authorization.registerFlow({ key: nativeKey, label: 'Replacement',
        methods: [{ id: 'oauth', label: 'Account' }], checkCredential: replacement, run: async () => {},
      })
      release()
      expect(await pending).toMatchObject({ available: replace, configured: false, nativeConfigured: false })
      expect(retired).not.toHaveBeenCalled()
      expect(replacement).toHaveBeenCalledTimes(replace ? 1 : 0)
    } finally {
      release()
      await pending
      read.mockRestore()
    }
  })

  it.each([false, true])('keeps stored-record evidence independent of a missing authorization service: %s', async (stored) => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(AuthorizationController)
    if (stored) await commit(ctx)
    expect(await ctx.authorizationController.describe('openai-codex')).toEqual({
      available: false, configured: stored, nativeConfigured: false, writable: false, inFlight: false, methods: [],
    })
  })

  it('does not interrogate unrelated API-key-only providers during account reads', async () => {
    const ctx = await boot(async () => {})
    const checkCredential = vi.fn(async () => true)
    ctx.authorization.registerFlow({ key: credentialKey('llm-pi-ai', 'key-only'), label: 'Key',
      methods: [{ id: 'api-key', label: 'Key' }], checkCredential, run: async () => {},
    })
    expect(await ctx.authorizationController.describe('key-only')).toMatchObject({ nativeConfigured: false })
    expect(checkCredential).not.toHaveBeenCalled()
  })

  it('does not return credential-check failures that could contain secrets', async () => {
    const ctx = await boot(async () => {})
    ctx.authorization.registerFlow({ key: credentialKey('llm-pi-ai', 'check-fails'), label: 'Check',
      methods: [{ id: 'oauth', label: 'Account' }],
      checkCredential: () => Promise.reject(new Error('token=private-check-token')), run: async () => {},
    })
    await expect(ctx.authorizationController.describe('check-fails')).rejects.toMatchObject({
      code: 'authorization/rejected', message: 'Could not check provider credentials',
    })
  })

  it('streams the URL and device code then reports persisted success without leaking the token', async () => {
    const ctx = await boot(async (session, owner) => {
      session.notify({ message: 'Open browser', url: 'https://auth.example/login', code: 'ABCD' })
      await commit(owner)
    })
    const before = await ctx.authorizationController.describe('openai-codex')
    expect(before).toMatchObject({ available: true, configured: false, writable: true })
    const frames = await Array.fromAsync(ctx.authorizationController.login('openai-codex', 'oauth', new AbortController().signal))
    expect(frames).toMatchObject([
      { type: 'started' },
      { type: 'notice', message: 'Open browser', url: 'https://auth.example/login', code: 'ABCD' },
      { type: 'outcome', status: 'authorized' },
    ])
    expect(JSON.stringify(frames)).not.toContain('private-token')
    expect(await ctx.authorizationController.describe('openai-codex')).toMatchObject({ configured: true, inFlight: false })
    await ctx.authorizationController.logout('openai-codex')
    expect(await ctx.credentials.readRecord(key)).toBeUndefined()
  })

  it('answers only its own pending prompt and rejects duplicate or foreign answers', async () => {
    let answer: string | undefined
    const ctx = await boot(async (session, owner) => {
      answer = await session.prompt({ kind: 'secret', message: 'Code', placeholder: 'Paste here' })
      await commit(owner)
    })
    const iterator = ctx.authorizationController.login('openai-codex', 'oauth', new AbortController().signal)[Symbol.asyncIterator]()
    const started = await frame(iterator)
    const question = await frame(iterator)
    if (started.type !== 'started' || question.type !== 'prompt') throw new Error('Missing expected prompt')
    expect(question.prompt).toEqual({ kind: 'secret', message: 'Code', placeholder: 'Paste here' })
    expect(() => { ctx.authorizationController.answer(brandString<AuthorizationAttemptId>('foreign'), question.promptId, 'stolen') }).toThrow()
    ctx.authorizationController.answer(started.attemptId, question.promptId, 'copied-code')
    expect(() => { ctx.authorizationController.answer(started.attemptId, question.promptId, 'replay') }).toThrow()
    expect(await frame(iterator)).toEqual({ type: 'outcome', status: 'authorized' })
    await iterator.next()
    expect(answer).toBe('copied-code')
  })

  it('validates select answers and suppresses prompt signal from the wire', async () => {
    const ctx = await boot(async (session, owner) => {
      expect(await session.prompt({ kind: 'select', message: 'Method', options: [{ id: 'device', label: 'Device code' }], signal: new AbortController().signal })).toBe('device')
      await commit(owner)
    })
    const iterator = ctx.authorizationController.login('openai-codex', 'oauth', new AbortController().signal)[Symbol.asyncIterator]()
    const started = await frame(iterator)
    const question = await frame(iterator)
    if (started.type !== 'started' || question.type !== 'prompt') throw new Error('Missing expected prompt')
    expect(question.prompt).not.toHaveProperty('signal')
    expect(() => { ctx.authorizationController.answer(started.attemptId, question.promptId, 'invalid') }).toThrow()
    ctx.authorizationController.answer(started.attemptId, question.promptId, 'device')
    expect(await frame(iterator)).toEqual({ type: 'outcome', status: 'authorized' })
    await iterator.next()
  })

  it('withdraws a losing manual prompt without cancelling successful browser login', async () => {
    const manual = new AbortController()
    const ctx = await boot(async (session, owner) => {
      await session.prompt({ kind: 'text', message: 'Callback', signal: manual.signal }).catch(() => undefined)
      await commit(owner)
    })
    const iterator = ctx.authorizationController.login('openai-codex', 'oauth', new AbortController().signal)[Symbol.asyncIterator]()
    await frame(iterator)
    const question = await frame(iterator)
    manual.abort()
    expect(await frame(iterator)).toMatchObject({ type: 'withdrawn', promptId: question.type === 'prompt' ? question.promptId : '' })
    expect(await frame(iterator)).toEqual({ type: 'outcome', status: 'authorized' })
    await iterator.next()
  })

  it('cancels pending questions when the caller leaves and allows another attempt', async () => {
    let stopped = false
    const ctx = await boot(async (session) => {
      try { await session.prompt({ kind: 'text', message: 'Code' }) } finally { stopped = true }
    })
    const abort = new AbortController()
    const iterator = ctx.authorizationController.login('openai-codex', 'oauth', abort.signal)[Symbol.asyncIterator]()
    const started = await frame(iterator)
    const question = await frame(iterator)
    await expect(ctx.authorizationController.logout('openai-codex')).rejects.toMatchObject({ code: 'authorization/rejected' })
    abort.abort()
    expect(await iterator.next()).toMatchObject({ done: true })
    expect(stopped).toBe(true)
    expect(await ctx.authorizationController.describe('openai-codex')).toMatchObject({ inFlight: false })
    if (started.type !== 'started' || question.type !== 'prompt') throw new Error('Missing prompt')
    expect(() => { ctx.authorizationController.answer(started.attemptId, question.promptId, 'late') }).toThrow()
  })

  it('refuses a concurrent attempt without cancelling the first', async () => {
    const ctx = await boot(async (session) => { await session.prompt({ kind: 'text', message: 'Code' }) })
    const abort = new AbortController()
    const first = ctx.authorizationController.login('openai-codex', 'oauth', abort.signal)[Symbol.asyncIterator]()
    await frame(first)
    await frame(first)
    const second = ctx.authorizationController.login('openai-codex', 'oauth', new AbortController().signal)
    await expect(Array.fromAsync(second)).rejects.toMatchObject({ code: 'authorization/rejected' })
    expect(await ctx.authorizationController.describe('openai-codex')).toMatchObject({ inFlight: true })
    abort.abort()
    await first.next()
  })

  it('does not return provider failure messages that might include secrets', async () => {
    const ctx = await boot(() => Promise.reject(new Error('access_token=private-token')))
    await expect(Array.fromAsync(ctx.authorizationController.login('openai-codex', 'oauth', new AbortController().signal)))
      .rejects.toMatchObject({ code: 'authorization/rejected', message: 'Sign-in failed; retry authorization' })
  })

  it('cancels on controller disposal and does not delete unrelated records', async () => {
    const ctx = await boot(async (session) => { await session.prompt({ kind: 'text', message: 'Code' }) })
    const other = credentialKey('other-plugin', 'openai-codex')
    await ctx.credentials.modifyRecord(other, () => Promise.resolve({ kind: 'grant', payload: 'unrelated' }))
    const iterator = ctx.authorizationController.login('openai-codex', 'oauth', new AbortController().signal)[Symbol.asyncIterator]()
    await frame(iterator)
    await frame(iterator)
    ctx.registry.delete(AuthorizationController)
    expect(await iterator.next()).toMatchObject({ done: true })
    expect(await ctx.credentials.readRecord(other)).toEqual({ kind: 'grant', payload: 'unrelated' })
  })
})
