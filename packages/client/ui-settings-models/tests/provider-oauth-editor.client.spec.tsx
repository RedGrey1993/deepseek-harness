// @vitest-environment jsdom
/** Provider account controls and API-key writes use the loaded provider's methods. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import type { ProviderAuthorizationState, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import { createModelsOperations } from '../src/client/operations.ts'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const profileSchema = Schema.object({
  providers: Schema.dict(Schema.object({
    apiKeyEnv: Schema.string().role('credential-ref'),
    baseURL: Schema.string(),
    api: Schema.union(['openai-completions', 'openai-responses']),
    models: Schema.array(Schema.object({ id: Schema.string().required() })),
  })),
})

const xaiAuthorization: ProviderAuthorizationState = {
  available: true, configured: false, nativeConfigured: false, inFlight: false, writable: true,
  methods: [{ id: 'oauth', label: 'xAI' }, { id: 'api-key', label: 'API key' }],
}
const codexAuthorization: ProviderAuthorizationState = {
  ...xaiAuthorization, methods: [{ id: 'oauth', label: 'ChatGPT' }],
}

function ok<T>(value: T) {
  return { ok: true as const, value }
}

async function mountEditor(options: {
  provider?: string
  authorization?: ProviderAuthorizationState
  declared?: boolean
  local?: boolean
  apiKeyEnv?: string
  keyConfigured?: boolean
  authorizationFailure?: string
} = {}) {
  const provider = options.provider ?? 'xai'
  const profile = options.apiKeyEnv === undefined ? {} : { apiKeyEnv: options.apiKeyEnv }
  const namespace: SettingsNamespaceView = {
    ns: 'llm-pi-ai',
    autoGenerate: true,
    schema: JSON.parse(JSON.stringify(profileSchema.toJSON())) as JsonValue,
    value: { providers: { [provider]: profile } },
    user: { providers: { [provider]: profile } },
    applies: 'live', secrets: [], revision: 7,
  }
  const remote = {
    $host: { isLoopback: options.local ?? true },
    llm: {
      listProviders: vi.fn(async () => ok([{ id: provider, name: provider }])),
      listConfigurableProviders: vi.fn(async () => ok([{
        provider, displayName: provider, settingsNs: namespace.ns,
        settingsPath: ['providers', provider], declared: options.declared ?? false,
      }])),
      discoverModels: vi.fn(async () => ok([])),
    },
    settings: {
      describe: vi.fn(async () => ok({ writable: true, hasDocument: true, namespaces: [namespace] })),
      mutate: vi.fn(async () => ok(namespace)),
    },
    credentials: {
      describe: vi.fn(async (refs: readonly string[]) => ok(Object.fromEntries(refs.map(ref => [
        ref, { configured: options.keyConfigured ?? false, writable: true },
      ])))),
      set: vi.fn(async () => ok(undefined)),
      unset: vi.fn(async () => ok(undefined)),
    },
    authorization: {
      describe: vi.fn(async () => options.authorizationFailure === undefined
        ? ok(options.authorization ?? xaiAuthorization)
        : { ok: false as const, error: new RemoteError('gateway/internal', options.authorizationFailure, {}) }),
    },
  }
  const ctx = { remote } as never
  const controller = new ModelsSettingsStore(ctx, settingsSchema, new SettingsDescribeMirror(ctx))
  await controller.load()
  const operations = createModelsOperations(ctx)
  render(<ModelsSection
    controller={controller}
    useSnapshot={bindSnapshotSelector(controller.store)}
    operations={operations}
    schema={settingsSchema}
    t={key => en[key]}
    renderSlot={() => null}
  />)
  fireEvent.click(screen.getByRole('button', { name: `${en.edit} ${provider}` }))
  if (options.local !== false && options.declared !== true
    && (options.authorization ?? xaiAuthorization).methods.some(method => method.id === 'oauth')) {
    await screen.findByText((options.authorization ?? xaiAuthorization).configured
      ? en.oauthConnected : en.oauthDisconnected)
  } else {
    await waitFor(() => { expect(remote.credentials.describe).toHaveBeenCalledTimes(2) })
  }
  return { remote, controller, operations }
}

describe('provider OAuth editor', () => {
  it('shows xAI account controls beside the unchanged write-only API-key input', async () => {
    const { remote } = await mountEditor()
    expect(screen.getByText('Provider account')).toBeTruthy()
    expect(screen.getByText('xAI')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sign in' }).disabled).toBe(false)
    expect(screen.queryByText('ChatGPT')).toBeNull()
    const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    expect(key.type).toBe('password')
    expect(key.value).toBe('')
    expect(key.disabled).toBe(false)

    fireEvent.change(key, { target: { value: '  xai-test-key  ' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(remote.credentials.set).toHaveBeenCalledExactlyOnceWith('XAI_API_KEY', 'xai-test-key') })
    expect(remote.settings.mutate).toHaveBeenCalledExactlyOnceWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'xai', 'apiKeyEnv'], value: 'XAI_API_KEY' },
    ], 7)
    await waitFor(() => { expect(screen.queryByLabelText(en.keyInput)).toBeNull() })
  })

  it('keeps a pending Codex login mounted when account enrichment temporarily fails', async () => {
    const { remote, controller, operations } = await mountEditor({ provider: 'openai-codex', authorization: codexAuthorization })
    let signal: AbortSignal | undefined
    let settled: Promise<void> | undefined
    operations.loginAuthorization = async (_provider, _method, abortSignal) => {
      signal = abortSignal
      settled = new Promise<void>((resolve) => {
        abortSignal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      await settled
    }
    fireEvent.click(screen.getByRole('button', { name: en.oauthSignIn }))
    expect(signal?.aborted).toBe(false)
    try {
      remote.authorization.describe.mockResolvedValueOnce({ ok: false,
        error: new RemoteError('gateway/internal', 'Account status temporarily unavailable', {}) })
      await act(async () => { await controller.load() })
      expect(screen.getByRole('alert').textContent).toBe('Account status temporarily unavailable')
      expect(signal?.aborted).toBe(false)
      expect(screen.queryByLabelText(en.keyInput)).toBeNull()
      expect(screen.getByText(en.oauthSigningIn)).toBeTruthy()
    } finally {
      cleanup()
      await settled
    }
    expect(signal?.aborted).toBe(true)
  })

  it('labels xAI as signed in when its stored grant and ambient API key are both configured', async () => {
    await mountEditor({ authorization: { ...xaiAuthorization, configured: true }, keyConfigured: true })
    expect(screen.getByRole('img', { name: en.oauthConnected })).toBeTruthy()
    expect(screen.queryByRole('img', { name: en.credentialConfigured })).toBeNull()
  })

  it.each(['xai', 'kimi-coding', 'github-copilot'])('labels provider-confirmed native authentication for %s', async (provider) => {
    await mountEditor({ provider, authorization: { ...xaiAuthorization, nativeConfigured: true } })
    expect(screen.getByRole('img', { name: en.nativeCredentialConfigured })).toBeTruthy()
    expect(screen.queryByRole('img', { name: en.oauthDisconnected })).toBeNull()
  })

  it('does not mistake an editor-derived reference for native authentication', async () => {
    await mountEditor({ provider: 'kimi-coding', keyConfigured: true })
    expect(screen.getByRole('img', { name: en.oauthDisconnected })).toBeTruthy()
    expect(screen.queryByRole('img', { name: en.nativeCredentialConfigured })).toBeNull()
  })

  it('explains unavailable sign-in without claiming that Codex is ready', async () => {
    const { controller } = await mountEditor({ provider: 'openai-codex', authorization: {
      available: false, configured: false, nativeConfigured: false, writable: false, inFlight: false, methods: [],
    } })
    expect(screen.getByText(en.oauthUnavailable)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.oauthSignIn })).toBeNull()
    expect(screen.queryByRole('img', { name: en.oauthConnected })).toBeNull()
    expect(controller.store.getSnapshot().rows[0]?.authorization?.configured).toBe(false)
  })

  it.each([false, true])('uses explicit xAI credential state instead of its grant: configured %s', async (keyConfigured) => {
    await mountEditor({
      authorization: { ...xaiAuthorization, configured: true }, apiKeyEnv: 'EXPLICIT_TOKEN', keyConfigured,
    })
    expect(screen.getByRole('img', { name: keyConfigured ? en.credentialConfigured : en.credentialMissing })).toBeTruthy()
    expect(screen.queryByRole('img', { name: en.oauthConnected })).toBeNull()
  })

  it('keeps OAuth-only Codex signed out despite an ambient derived API key', async () => {
    await mountEditor({ provider: 'openai-codex', authorization: codexAuthorization, keyConfigured: true })
    expect(screen.getByRole('img', { name: en.oauthDisconnected })).toBeTruthy()
    expect(screen.queryByRole('img', { name: en.credentialConfigured })).toBeNull()
  })

  it('does not create a key reference or rewrite settings when xAI is applied with a blank key', async () => {
    const { remote } = await mountEditor()
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(screen.queryByLabelText(en.keyInput)).toBeNull() })
    expect(remote.credentials.set).not.toHaveBeenCalled()
    expect(remote.settings.mutate).not.toHaveBeenCalled()
  })

  it('shows ChatGPT account controls without an API-key field for OAuth-only Codex', async () => {
    const { remote } = await mountEditor({ provider: 'openai-codex', authorization: codexAuthorization })
    expect(screen.getByText('Provider account')).toBeTruthy()
    expect(screen.getByText('ChatGPT')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Sign in' }).disabled).toBe(false)
    expect(screen.queryByLabelText(en.keyInput)).toBeNull()
    expect(remote.credentials.describe).toHaveBeenCalledExactlyOnceWith(['OPENAI_CODEX_API_KEY'])
    expect(remote.authorization.describe).toHaveBeenCalledWith('openai-codex')
  })

  it.each([
    { provider: 'openai', authorization: { ...xaiAuthorization, methods: [{ id: 'api-key', label: 'API key' }] } },
    { provider: 'custom', declared: true },
    { provider: 'xai', local: false },
  ])('keeps API-key editing without account controls for $provider', async (options) => {
    const { remote } = await mountEditor(options)
    expect(screen.getByLabelText<HTMLInputElement>(en.keyInput).type).toBe('password')
    expect(screen.queryByText(en.oauthAccount)).toBeNull()
    expect(screen.queryByRole('button', { name: en.oauthSignIn })).toBeNull()
    if ('declared' in options || 'local' in options) expect(remote.authorization.describe).not.toHaveBeenCalled()
    else expect(remote.authorization.describe).toHaveBeenCalledTimes(1)
  })

  it.each([
    { provider: 'xai', authorization: xaiAuthorization },
    { provider: 'openai-codex', authorization: codexAuthorization },
  ])('preserves an explicit API-key override for $provider without offering a misleading sign-in', async (options) => {
    const { remote } = await mountEditor({ ...options, apiKeyEnv: 'EXPLICIT_TOKEN', keyConfigured: true })
    expect(screen.getByText(en.oauthOverride)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.oauthSignIn }).disabled).toBe(true)
    const key = screen.getByLabelText<HTMLInputElement>(en.keyInput)
    expect(key.value).toBe('')
    expect(key.placeholder).toBe(en.keyStored)
    expect(key.disabled).toBe(false)
    fireEvent.change(key, { target: { value: ' replacement-key ' } })
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(remote.credentials.set).toHaveBeenCalledExactlyOnceWith('EXPLICIT_TOKEN', 'replacement-key') })
    expect(remote.settings.mutate).not.toHaveBeenCalled()
    await waitFor(() => { expect(screen.queryByLabelText(en.keyInput)).toBeNull() })
  })
})
