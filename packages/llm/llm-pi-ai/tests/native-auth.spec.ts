/** Provider-local credential detection uses pi-ai's native checks without network validation or OAuth refresh. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordKeyFor } from '../src/auth.ts'
import { registerPiAiFlows } from '../src/login.ts'
import * as catalog from '../src/catalog.ts'
import { memoryAuth } from './auth-double.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  try {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  } finally {
    vi.restoreAllMocks()
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  }
})

async function harness(auth: ReturnType<typeof memoryAuth>): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-auth-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalCredentialProvider, { path: join(root, '.credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  registerPiAiFlows(ctx, auth)
  return ctx
}

describe('pi-ai authorization credential checks', () => {
  it.each([
    ['kimi-coding', 'KIMI_API_KEY', 'KIMI_CODING_API_KEY'],
    ['github-copilot', 'COPILOT_GITHUB_TOKEN', 'GITHUB_COPILOT_API_KEY'],
    ['xai', 'XAI_API_KEY', 'UNRELATED_API_KEY'],
  ])('detects %s through its native environment name rather than a derived UI reference', async (provider, nativeRef, otherRef) => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Credential checks must not use the network'))
    const values = new Map([[otherRef, 'unrelated-key']])
    const auth = memoryAuth()
    const env = vi.fn((name: string) => Promise.resolve(values.get(name)))
    auth.authContext.env = env
    const modify = vi.spyOn(auth.credentials, 'modify')
    const ctx = await harness(auth)
    const check = ctx.authorization.describe(recordKeyFor(provider))?.checkCredential
    expect(check).toBeTypeOf('function')
    if (check === undefined) throw new Error(`Missing credential check for ${provider}`)

    await expect(check()).resolves.toBe(false)
    expect(env).toHaveBeenCalledWith(nativeRef)
    values.set(nativeRef, 'native-test-key')
    await expect(check()).resolves.toBe(true)
    values.delete(nativeRef)
    await expect(check()).resolves.toBe(false)

    expect(auth.stored.size).toBe(0)
    expect(modify).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
  })

  it('reports an expired stored OAuth grant without refreshing or rewriting it', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Credential checks must not refresh OAuth'))
    const grant = { type: 'oauth' as const, access: 'expired-access', refresh: 'refresh-must-not-be-used', expires: 1 }
    const auth = memoryAuth({ 'kimi-coding': grant })
    const modify = vi.spyOn(auth.credentials, 'modify')
    const env = vi.spyOn(auth.authContext, 'env')
    const ctx = await harness(auth)
    const check = ctx.authorization.describe(recordKeyFor('kimi-coding'))?.checkCredential
    if (check === undefined) throw new Error('Missing Kimi credential check')

    await expect(check()).resolves.toBe(true)

    expect(auth.stored.get('kimi-coding')).toBe(grant)
    expect(modify).not.toHaveBeenCalled()
    expect(env).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
  })

  it('does not reread and refresh an OAuth grant that appears during a native check', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Credential checks must not refresh OAuth'))
    const grant = { type: 'oauth' as const, access: 'expired-access', refresh: 'unused-refresh', expires: 1 }
    const auth = memoryAuth({ 'kimi-coding': grant })
    const read = vi.spyOn(auth.credentials, 'read').mockResolvedValueOnce(undefined)
    const modify = vi.spyOn(auth.credentials, 'modify')
    const ctx = await harness(auth)
    const check = ctx.authorization.describe(recordKeyFor('kimi-coding'))?.checkCredential
    if (check === undefined) throw new Error('Missing Kimi credential check')

    await expect(check()).resolves.toBe(false)
    expect(read).toHaveBeenCalledTimes(1)
    expect(modify).not.toHaveBeenCalled()
    expect(network).not.toHaveBeenCalled()
    expect(auth.stored.get('kimi-coding')).toBe(grant)
  })

  it('prefers the provider availability check over request-time credential resolution', async () => {
    const original = catalog.catalogProvider
    const provider = original('kimi-coding')
    const apiKey = provider?.auth.apiKey
    if (provider === undefined || apiKey === undefined) throw new Error('Missing Kimi API-key provider')
    const inspect = vi.fn<NonNullable<typeof apiKey.check>>(async () => ({ source: 'fixture', type: 'api_key' }))
    const resolve = vi.fn(() => Promise.reject(new Error('Request-time resolution is not a check')))
    vi.spyOn(catalog, 'catalogProvider').mockImplementation(id => id === 'kimi-coding'
      ? { ...provider, auth: { ...provider.auth, apiKey: { ...apiKey, check: inspect, resolve } } }
      : original(id))
    const auth = memoryAuth()
    const ctx = await harness(auth)
    const check = ctx.authorization.describe(recordKeyFor('kimi-coding'))?.checkCredential
    if (check === undefined) throw new Error('Missing Kimi credential check')

    await expect(check()).resolves.toBe(true)
    expect(inspect).toHaveBeenCalledOnce()
    expect(inspect.mock.calls[0]?.[0].ctx).toBe(auth.authContext)
    expect(inspect.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('resolves a captured API-key record without consulting ambient values', async () => {
    const auth = memoryAuth({ 'kimi-coding': { type: 'api_key', key: 'stored-key' } })
    const env = vi.spyOn(auth.authContext, 'env')
    const ctx = await harness(auth)
    const check = ctx.authorization.describe(recordKeyFor('kimi-coding'))?.checkCredential
    if (check === undefined) throw new Error('Missing Kimi credential check')

    await expect(check()).resolves.toBe(true)
    expect(env).not.toHaveBeenCalled()
  })

  it('does not treat an unrelated native API key as an OAuth-only Codex credential', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Credential checks must not use the network'))
    const auth = memoryAuth()
    const env = vi.fn(() => Promise.resolve('unrelated-native-key'))
    auth.authContext.env = env
    const ctx = await harness(auth)
    const check = ctx.authorization.describe(recordKeyFor('openai-codex'))?.checkCredential
    if (check === undefined) throw new Error('Missing Codex credential check')

    await expect(check()).resolves.toBe(false)

    expect(env).not.toHaveBeenCalled()
    expect(auth.stored.size).toBe(0)
    expect(network).not.toHaveBeenCalled()
  })
})
