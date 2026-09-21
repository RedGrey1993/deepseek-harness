/** Page-store join: directory × namespaces × credentials, with last-good rows on failure. */
import { describe, expect, it, vi } from 'vitest'
import type { ProviderAuthorizationState, RpcResponse } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { settingsSchema } from './settings-schema.client.ts'
import { joinProviderDirectory, ModelsSettingsStore, providerUsable } from '../src/client/store.ts'

it.each([false, true])('retains configuration diagnostics when the route is active: %s', (active) => {
  expect(joinProviderDirectory(active ? [{ id: 'openai', name: 'openai' }] : [], [{
    provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'],
    error: 'catalog unavailable',
  }])).toEqual([{
    provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'],
    active, error: 'catalog unavailable',
  }])
})

it('places account and official before third-party providers', () => {
  const providers = ['custom', 'deepseek-official', 'deepseek-account', 'openai']
  const directory = providers.map(provider => ({
    provider, displayName: provider, settingsNs: 'fixture', settingsPath: [],
  }))
  expect(joinProviderDirectory([], directory).map(row => row.provider))
    .toEqual(['deepseek-account', 'deepseek-official', 'custom', 'openai'])
  expect(directory.map(row => row.provider)).toEqual(providers)
})

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: false, error: { code: 'gateway/internal', message, details: {} } } }
}

/** Answers over the Remote carrier, which has no envelope. */
type RemoteAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteError }
function remoteOk<T>(value: T): RemoteAnswer<T> {
  return { ok: true, value }
}
function remoteFail<T>(message: string): RemoteAnswer<T> {
  return { ok: false, error: new RemoteError('gateway/internal', message, {}) }
}

const DIRECTORY = [
  { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true },
  { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true },
  { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false },
  { provider: 'ghost', displayName: 'Ghost', settingsNs: '', settingsPath: [], active: true },
]

const NAMESPACES = [
  {
    ns: 'llm-deepseek',
    schema: {},
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://base' },
    base: { baseURL: 'https://base' },
    autoGenerate: true, applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
  {
    ns: 'llm-deepseek-account',
    schema: {},
    value: { baseURL: 'https://base' },
    base: { baseURL: 'https://base' },
    autoGenerate: true, applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
  {
    ns: 'llm-pi-ai',
    schema: {},
    value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    user: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    autoGenerate: true, applies: 'live' as const,
    secrets: [],
    revision: 0,
  },
]

function api(overrides: {
  accountAvailable?: boolean
  providers?: () => Promise<RpcResponse<{ providers: typeof DIRECTORY }>>
  describeSettings?: () => Promise<RemoteAnswer<{ writable: boolean; hasDocument: boolean; namespaces: typeof NAMESPACES }>>
  describeCredentials?: (refs: readonly string[]) => Promise<RemoteAnswer<Record<string, unknown>>>
  describeAuthorization?: (provider: string) => Promise<RemoteAnswer<ProviderAuthorizationState>>
  local?: boolean
} = {}) {
  const seenRefs: string[][] = []
  const seenProviders: string[] = []
  const providers = overrides.providers ?? (() => Promise.resolve(ok({ providers: DIRECTORY })))
  let providerBatch: Promise<RpcResponse<{ providers: typeof DIRECTORY }>> | undefined
  let providerBatchReads = 0
  const readProviderBatch = (): Promise<RpcResponse<{ providers: typeof DIRECTORY }>> => {
    providerBatch ??= providers()
    const current = providerBatch
    providerBatchReads += 1
    if (providerBatchReads % 2 === 0) providerBatch = undefined
    return current
  }
  const mapProviderBatch = async <T>(
    project: (rows: typeof DIRECTORY) => T,
  ): Promise<RemoteAnswer<T>> => {
    const response = await readProviderBatch()
    return response.result.ok
      ? remoteOk(project(response.result.value.providers))
      : remoteFail(response.result.error.message)
  }
  const face = {
    session: { modelCatalog: async () => remoteOk({ groups: overrides.accountAvailable
      ? [{ id: 'deepseek-account', models: [{ id: 'deepseek-flash' }] }] : [] }) },
    llm: {
      listProviders: () => mapProviderBatch(rows => rows
        .filter(row => row.active)
        .map(row => ({ id: row.provider, name: row.displayName }))),
      listConfigurableProviders: () => mapProviderBatch(rows => rows
        .filter(row => row.settingsNs !== '')
        .map(({ active: _active, ...row }) => row)),
      discoverModels: () => Promise.resolve(remoteOk([])),
    },
    authorization: {
      describe: (provider: string) => {
        seenProviders.push(provider)
        return overrides.describeAuthorization?.(provider) ?? Promise.resolve(remoteOk({
          available: false, configured: false, nativeConfigured: false, inFlight: false, writable: true, methods: [],
        }))
      },
    },
    settings: {
      describe: overrides.describeSettings
        ?? (() => Promise.resolve(remoteOk({ writable: true, hasDocument: false, namespaces: NAMESPACES }))),
      mutate: () => Promise.resolve(remoteFail('the store spec issues no writes')),
    },
    credentials: {
      describe: (refs: readonly string[]) => {
        seenRefs.push([...refs])
        return (overrides.describeCredentials ?? (asked => Promise.resolve(remoteOk(
          Object.fromEntries(asked.map(ref => [ref, { configured: ref === 'OPENAI_API_KEY', writable: true }])),
        ))))(refs)
      },
      set: () => Promise.resolve(remoteOk(undefined)),
      unset: () => Promise.resolve(remoteOk(undefined)),
    },
  }
  // The page plugin's context, scripted down to the namespaces it reaches.
  const ctx = { remote: { $host: { isLoopback: overrides.local ?? false }, ...face } } as never
  return { ctx, face, mirror: new SettingsDescribeMirror(ctx), seenRefs, seenProviders }
}

describe('ModelsSettingsStore', () => {
  it('joins rows with configured, removable, and credential state', async () => {
    const { ctx, mirror, seenRefs } = api()
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.writable).toBe(true)
    expect(state.credentialError).toBeNull()
    // Named references first (rows order), then the derived <ROUTE>_API_KEY
    // of every row whose profile names none — one batched describe.
    expect(seenRefs).toEqual([['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GHOST_API_KEY']])
    const byProvider = new Map(state.rows.map(row => [row.entry.provider, row]))
    expect(byProvider.get('deepseek-official')).toMatchObject({
      configured: true,
      removable: false,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      credential: { configured: false, writable: true },
    })
    expect(byProvider.get('openai')).toMatchObject({
      configured: true,
      removable: true,
      apiKeyEnv: 'OPENAI_API_KEY',
      credential: { configured: true },
    })
    expect(byProvider.get('anthropic')).toMatchObject({ configured: false, removable: false })
    expect(byProvider.get('anthropic')?.apiKeyEnv).toBeUndefined()
    expect(byProvider.get('ghost')).toMatchObject({ configured: false, removable: false })
    expect(state.namespaces.get('llm-pi-ai')?.ns).toBe('llm-pi-ai')
  })

  it('degrades the credential badge, not the page, when the credential domain fails', async () => {
    const { ctx, mirror } = api({ describeCredentials: () => Promise.resolve(remoteFail('no provider')) })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.credentialError).toBe('no provider')
    expect(state.rows.every(row => row.credential === undefined)).toBe(true)
  })

  it('surfaces a directory failure and keeps the last good rows', async () => {
    const { ctx, mirror } = api()
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    expect(store.store.getSnapshot().rows).toHaveLength(4)
    const broken = api({ providers: () => Promise.resolve(fail('directory down')) })
    const failing = new ModelsSettingsStore(broken.ctx, settingsSchema, broken.mirror)
    await failing.load()
    expect(failing.store.getSnapshot()).toMatchObject({ status: 'error', error: 'directory down' })
    // The first store's snapshot is untouched by the second's failure.
    expect(store.store.getSnapshot().status).toBe('ready')
  })

  it('surfaces a configurable-provider directory failure', async () => {
    const { ctx, face, mirror } = api()
    const llm = (face as unknown as {
      llm: { listConfigurableProviders: () => Promise<RemoteAnswer<never>> }
    }).llm
    llm.listConfigurableProviders = () => Promise.resolve(remoteFail<never>('configuration directory down'))
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)

    await store.load()

    expect(store.store.getSnapshot()).toMatchObject({
      status: 'error', error: 'configuration directory down',
    })
  })

  it('lets the newest load win over a stale slow response', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    const { ctx, mirror } = api({
      providers: async () => {
        call += 1
        if (call === 1) {
          await gate
          return fail('stale slow failure')
        }
        return ok({ providers: DIRECTORY })
      },
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    const first = store.load()
    const second = store.load()
    release?.()
    await Promise.all([first, second])
    expect(store.store.getSnapshot().status).toBe('ready')
  })
})

describe('provider authorization join', () => {
  const account: ProviderAuthorizationState = {
    available: true, configured: false, nativeConfigured: false, inFlight: false, writable: true,
    methods: [{ id: 'oauth', label: 'xAI' }, { id: 'api-key', label: 'API key' }],
  }
  const providers = [
    ...DIRECTORY,
    { provider: 'xai', displayName: 'xAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'xai'], active: true, declared: false },
    { provider: 'openai-codex', displayName: 'Codex', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai-codex'], active: false },
    { provider: 'custom', displayName: 'Custom', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'custom'], active: true, declared: true },
  ]

  it('queries every installed pi-ai row in parallel, including dormant routes but not declared or DeepSeek routes', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { ctx, mirror, seenProviders } = api({
      local: true,
      providers: async () => ok({ providers }),
      describeAuthorization: async (provider) => {
        await gate
        return remoteOk({ ...account, configured: provider === 'xai' })
      },
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    const loading = store.load()
    try {
      await vi.waitFor(() => {
        expect(seenProviders).toEqual(['openai', 'anthropic', 'xai', 'openai-codex'])
      })
      expect(store.store.getSnapshot().status).toBe('loading')
    } finally {
      release()
      await loading
    }
    const state = store.store.getSnapshot()
    expect(state).toMatchObject({ status: 'ready', credentialError: null })
    const byProvider = new Map(state.rows.map(row => [row.entry.provider, row]))
    expect(byProvider.get('xai')?.authorization).toEqual({ ...account, configured: true })
    expect(byProvider.get('openai-codex')).toMatchObject({
      entry: { active: false }, configured: false, authorization: account,
    })
    for (const provider of ['deepseek-official', 'custom', 'ghost']) {
      expect(byProvider.get(provider)?.authorization).toBeUndefined()
    }
  })

  it('never queries account metadata from a non-loopback browser', async () => {
    const { ctx, mirror, seenProviders } = api({
      local: false, providers: async () => ok({ providers }),
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    expect(seenProviders).toEqual([])
    expect(store.store.getSnapshot().status).toBe('ready')
    expect(store.store.getSnapshot().rows.every(row => row.authorization === undefined)).toBe(true)
  })

  it('keeps the page and successful accounts ready when one describe fails', async () => {
    const { ctx, mirror } = api({
      local: true,
      describeAuthorization: async provider => provider === 'openai'
        ? remoteFail('authorization unavailable') : remoteOk(account),
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state).toMatchObject({ status: 'ready', error: null, credentialError: 'authorization unavailable' })
    expect(state.rows.find(row => row.entry.provider === 'openai')).toMatchObject({
      credential: { configured: true },
    })
    expect(state.rows.find(row => row.entry.provider === 'openai')?.authorization).toBeUndefined()
    expect(state.rows.find(row => row.entry.provider === 'anthropic')?.authorization).toEqual(account)
  })

  it('retains last-confirmed account metadata on failure and replaces it with a successful unavailable response', async () => {
    const unavailable: ProviderAuthorizationState = {
      available: false, configured: false, nativeConfigured: false, inFlight: false, writable: false, methods: [],
    }
    let response: RemoteAnswer<ProviderAuthorizationState> = remoteOk(account)
    const { ctx, mirror } = api({
      local: true,
      providers: async () => ok({ providers: providers.filter(row => row.provider === 'xai') }),
      describeAuthorization: async () => response,
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    expect(store.store.getSnapshot().rows[0]?.authorization).toEqual(account)

    response = remoteFail('temporary account failure')
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'ready', error: null, credentialError: 'temporary account failure',
      rows: [{ authorization: account }],
    })

    response = remoteOk(unavailable)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'ready', error: null, credentialError: null,
      rows: [{ authorization: unavailable }],
    })
  })

  it.each(['custom', 'namespace', 'provider'] as const)('does not retain account metadata after a change of %s', async (change) => {
    const original = {
      provider: 'xai', displayName: 'xAI', settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'xai'], active: true, declared: false,
    }
    let entry = original
    let response: RemoteAnswer<ProviderAuthorizationState> = remoteOk(account)
    const { ctx, mirror, seenProviders } = api({
      local: true,
      providers: async () => ok({ providers: [entry] }),
      describeAuthorization: async () => response,
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    expect(store.store.getSnapshot().rows[0]?.authorization).toEqual(account)

    entry = change === 'custom' ? { ...original, declared: true }
      : change === 'namespace' ? { ...original, settingsNs: 'llm-deepseek' }
        : { ...original, provider: 'openai-codex', settingsPath: ['providers', 'openai-codex'] }
    response = remoteFail('account unavailable')
    await store.load()
    expect(store.store.getSnapshot().status).toBe('ready')
    expect(store.store.getSnapshot().rows[0]?.authorization).toBeUndefined()
    expect(seenProviders).toEqual(change === 'provider' ? ['xai', 'openai-codex'] : ['xai'])
  })

  it('retains the credential diagnostic when account enrichment also fails', async () => {
    const { ctx, mirror } = api({
      local: true,
      describeCredentials: async () => remoteFail('credentials unavailable'),
      describeAuthorization: async () => remoteFail('authorization unavailable'),
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'ready', error: null, credentialError: 'credentials unavailable',
    })
  })

  it.each(['success', 'failure'] as const)('ignores a stale account %s after a newer load commits', async (outcome) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const { ctx, mirror } = api({
      local: true,
      providers: async () => ok({ providers: providers.filter(row => row.provider === 'xai') }),
      describeAuthorization: async () => {
        calls += 1
        if (calls === 1) {
          await gate
          return outcome === 'success' ? remoteOk(account) : remoteFail('stale account failure')
        }
        return remoteOk({ ...account, configured: true })
      },
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    const first = store.load()
    try {
      await vi.waitFor(() => { expect(calls).toBe(1) })
      await store.load()
      expect(store.store.getSnapshot()).toMatchObject({
        status: 'ready', credentialError: null,
        rows: [{ authorization: { configured: true } }],
      })
    } finally {
      release()
      await first
    }
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'ready', error: null, credentialError: null,
      rows: [{ authorization: { configured: true } }],
    })
  })
})

describe('edge joins', () => {
  it('treats a non-object profile as having no credential reference', async () => {
    const { ctx, mirror } = api({
      describeSettings: () => Promise.resolve(remoteOk({
        writable: true,
        hasDocument: false,
        namespaces: [{
          ns: 'llm-pi-ai',
          schema: {},
          value: { providers: { weird: 'oops' } },
          autoGenerate: true, applies: 'live' as const,
          secrets: [],
          revision: 0,
        }] as never,
      })),
      providers: () => Promise.resolve(ok({
        providers: [
          { provider: 'weird', displayName: 'weird', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'weird'], active: false },
        ] as never,
      })),
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    const state = store.store.getSnapshot()
    expect(state.rows[0]).toMatchObject({ configured: true, removable: false })
    expect(state.rows[0]?.apiKeyEnv).toBeUndefined()
  })

  it('describes the derived reference for a row whose profile names none', async () => {
    const { ctx, mirror, seenRefs } = api({
      describeSettings: () => Promise.resolve(remoteOk({
        writable: true,
        hasDocument: false,
        namespaces: [{ ns: 'llm-pi-ai', schema: {}, value: { providers: {} }, autoGenerate: true, applies: 'live' as const, secrets: [], revision: 0 }] as never,
      })),
      providers: () => Promise.resolve(ok({
        providers: [
          { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: false },
        ] as never,
      })),
      describeCredentials: refs => Promise.resolve(remoteOk(
        Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])),
      )),
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    // The dormant row names no reference, so the join asks about the page's
    // own derived <ROUTE>_API_KEY — what the editor would display for it.
    expect(seenRefs).toEqual([['ANTHROPIC_API_KEY']])
    const state = store.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.rows[0]?.credential).toBeUndefined()
    expect(state.rows[0]?.derivedCredential).toMatchObject({ configured: true })
  })

  it('surfaces a settings describe failure', async () => {
    const { ctx, mirror } = api({ describeSettings: () => Promise.resolve(remoteFail('settings down')) })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'settings down' })
  })

  it('reports a terminally unavailable settings mirror precisely', async () => {
    const { ctx } = api()
    const store = new ModelsSettingsStore(
      ctx,
      settingsSchema,
      new SettingsDescribeMirror(ctx, 'memory'),
    )
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'settings are unavailable in this browser',
    })
  })

  it('reuses a held settings view after its refresh fails', async () => {
    let settingsCall = 0
    const { ctx, mirror } = api({
      describeSettings: () => {
        settingsCall += 1
        return Promise.resolve(settingsCall === 1
          ? remoteOk({ writable: true, hasDocument: false, namespaces: NAMESPACES })
          : remoteFail('settings refresh down'))
      },
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    await mirror.load()
    expect(mirror.getSnapshot().error).toBe('settings refresh down')
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'ready', error: null })
    expect(store.store.getSnapshot().rows).toHaveLength(4)
  })

  it('drops a stale successful response after a newer load finished', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    const { ctx, mirror } = api({
      providers: async () => {
        call += 1
        if (call === 1) {
          await gate
          return ok({ providers: [] as never })
        }
        return ok({ providers: DIRECTORY })
      },
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    const first = store.load()
    const second = store.load()
    await second
    release?.()
    await first
    // The stale empty directory never overwrote the newer join.
    expect(store.store.getSnapshot().rows).toHaveLength(4)
  })
})


it.each([false, true])('uses account availability without asking for an API key: %s', async (accountAvailable) => {
  const { ctx, mirror, seenRefs } = api({ accountAvailable, providers: async () => ok({ providers: [{
    provider: 'deepseek-account', displayName: 'DeepSeek Account', settingsNs: 'llm-deepseek-account', settingsPath: [], active: true,
  }] }) })
  const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
  await store.load()
  const rows = store.store.getSnapshot().rows
  expect(rows).toHaveLength(accountAvailable ? 1 : 0)
  if (accountAvailable) {
    expect(rows[0]).toMatchObject({ accountAvailable: true, apiKeyEnv: undefined, credential: undefined })
    expect(providerUsable(rows[0]!)).toBe(true)
  }
  expect(store.store.getSnapshot().namespaces.get('llm-deepseek-account')?.ns).toBe('llm-deepseek-account')
  expect(seenRefs).toEqual([])
})

it('removes the account row after sign-out and restores it after sign-in', async () => {
  const overrides = { accountAvailable: true, providers: async () => ok({ providers: [{
    provider: 'deepseek-account', displayName: 'DeepSeek Account', settingsNs: 'llm-deepseek-account', settingsPath: [], active: true,
  }, ...DIRECTORY] }) }
  const { ctx, mirror } = api(overrides)
  const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
  await store.load()
  expect(store.store.getSnapshot().rows[0]?.entry.provider).toBe('deepseek-account')
  overrides.accountAvailable = false
  await store.load()
  expect(store.store.getSnapshot().rows.map(row => row.entry.provider)).not.toContain('deepseek-account')
  expect(store.store.getSnapshot().rows).toHaveLength(DIRECTORY.length)
  overrides.accountAvailable = true
  await store.load()
  expect(store.store.getSnapshot().rows[0]?.entry.provider).toBe('deepseek-account')
})
