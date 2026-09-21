/** Pure first-run readiness projection over the shared Models join. */
import { describe, expect, it } from 'vitest'
import type { CredentialInfo } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsSettingsState, ProviderRow } from '../src/client/store.ts'
import { onboardingReadiness, providerUsable } from '../src/client/store.ts'

const missingCredential: CredentialInfo = { configured: false, writable: true }

function row(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    entry: {
      provider: 'deepseek-official',
      displayName: 'DeepSeek',
      settingsNs: 'llm-deepseek',
      settingsPath: [],
      active: true,
    },
    configured: true,
    removable: false,
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    credential: missingCredential,
    ...overrides,
  }
}

/** A second provider the user configured themselves. */
function otherRow(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    entry: {
      provider: 'hfai',
      displayName: 'HFAI',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'hfai'],
      active: true,
    },
    configured: true,
    removable: true,
    apiKeyEnv: 'HFAI_API_KEY',
    credential: { configured: true, source: 'file', writable: true },
    ...overrides,
  }
}

function state(overrides: Partial<ModelsSettingsState> = {}): ModelsSettingsState {
  return {
    status: 'ready',
    error: null,
    credentialError: null,
    writable: true,
    rows: [row()],
    namespaces: new Map(),
    ...overrides,
  }
}

describe('providerUsable', () => {
  it('requires a registered route and a stored key for every named reference', () => {
    expect(providerUsable(otherRow())).toBe(true)
    expect(providerUsable(otherRow({ entry: { ...otherRow().entry, active: false } }))).toBe(false)
    expect(providerUsable(otherRow({ credential: missingCredential }))).toBe(false)
    expect(providerUsable(otherRow({ credential: undefined }))).toBe(false)
  })

  it('preserves native authentication for custom routes and installed providers without OAuth', () => {
    const native = otherRow({ apiKeyEnv: undefined, credential: undefined })
    expect(providerUsable({ ...native, entry: { ...native.entry, declared: true } })).toBe(true)
    expect(providerUsable({ ...native, authorization: {
      available: true, configured: false, nativeConfigured: false, writable: true, inFlight: false,
      methods: [{ id: 'api-key', label: 'API key' }],
    } })).toBe(true)
  })

  it.each(['xai', 'openai-codex'])('requires credential evidence for the installed OAuth provider %s', (provider) => {
    const native = otherRow({ apiKeyEnv: undefined, credential: undefined })
    const account = { available: true, configured: false, nativeConfigured: false, writable: true, inFlight: false,
      methods: [{ id: 'oauth', label: 'Account' },
        ...provider === 'xai' ? [{ id: 'api-key', label: 'API key' }] : []] }
    const candidate = { ...native, entry: { ...native.entry, provider } }
    expect(providerUsable(candidate)).toBe(false)
    expect(providerUsable({ ...candidate, authorization: account })).toBe(false)
    expect(providerUsable({ ...candidate, authorization: { ...account, configured: true } })).toBe(true)
    expect(providerUsable({ ...candidate, authorization: account,
      derivedCredential: { configured: true, writable: false, source: 'env' } })).toBe(false)
    expect(providerUsable({ ...candidate, authorization: { ...account, nativeConfigured: true } })).toBe(true)
    expect(providerUsable({ ...candidate, authorization: { ...account, configured: true },
      apiKeyEnv: 'OVERRIDE', credential: missingCredential })).toBe(false)
  })
})

describe('onboardingReadiness', () => {
  it.each(['kimi-coding', 'github-copilot'])('accepts provider-confirmed native credentials for %s', (provider) => {
    const native = otherRow({ apiKeyEnv: undefined, credential: undefined })
    const configured = { ...native, entry: { ...native.entry, provider },
      authorization: { available: true, configured: false, nativeConfigured: true, writable: true, inFlight: false,
        methods: [{ id: 'oauth', label: 'Account' }, { id: 'api-key', label: 'Key' }] } }
    expect(onboardingReadiness(state({ rows: [row(), configured] }))).toEqual({ kind: 'provider-ready' })
    expect(onboardingReadiness(state({ rows: [row(), { ...configured,
      authorization: { ...configured.authorization, nativeConfigured: false },
      derivedCredential: { configured: true, writable: true },
    }] }))).toEqual({ kind: 'credential-missing' })
  })

  it.each([false, true])('does not infer Codex readiness from unavailable login methods: stored %s', (stored) => {
    const native = otherRow({ apiKeyEnv: undefined, credential: undefined })
    const codex = { ...native, entry: { ...native.entry, provider: 'openai-codex' },
      authorization: { available: false, configured: stored, nativeConfigured: false, writable: false, inFlight: false, methods: [] } }
    expect(onboardingReadiness(state({ rows: [row(), codex] })))
      .toEqual({ kind: stored ? 'provider-ready' : 'credential-missing' })
  })

  it('waits for the first join and skips onboarding when the adapter directory entry is absent', () => {
    expect(onboardingReadiness(state({ status: 'idle', rows: [] }))).toEqual({ kind: 'loading' })
    expect(onboardingReadiness(state({ status: 'loading', rows: [] }))).toEqual({ kind: 'loading' })
    expect(onboardingReadiness(state({ rows: [] }))).toEqual({ kind: 'adapter-absent' })
    expect(onboardingReadiness(state({
      rows: [row({
        entry: {
          ...row().entry,
          settingsNs: '',
        },
      })],
    }))).toEqual({ kind: 'adapter-absent' })
  })

  it('reports a missing writable effective credential', () => {
    expect(onboardingReadiness(state())).toEqual({ kind: 'credential-missing' })
  })

  it('ends onboarding once any other registered provider can serve requests', () => {
    expect(onboardingReadiness(state({ rows: [row(), otherRow()] }))).toEqual({ kind: 'provider-ready' })
    // A provider the user cannot reach yet leaves the prompt in place.
    expect(onboardingReadiness(state({
      rows: [row(), otherRow({ credential: missingCredential })],
    }))).toEqual({ kind: 'credential-missing' })
  })

  it('accepts file and process-environment credentials without prompting', () => {
    expect(onboardingReadiness(state({
      rows: [row({ credential: { configured: true, source: 'file', writable: true } })],
    }))).toEqual({ kind: 'provider-ready' })
    expect(onboardingReadiness(state({
      rows: [row({ credential: { configured: true, source: 'env', writable: false } })],
    }))).toEqual({ kind: 'provider-ready' })
  })

  it('turns missing capabilities into diagnostics that never block the product', () => {
    expect(onboardingReadiness(state({ status: 'error', error: 'settings down' }))).toEqual({
      kind: 'unavailable',
      reason: 'load-failed',
    })
    expect(onboardingReadiness(state({
      rows: [row({ entry: { ...row().entry, active: false } })],
    }))).toEqual({ kind: 'unavailable', reason: 'provider-inactive' })
    expect(onboardingReadiness(state({
      credentialError: 'credentials service is absent',
    }))).toEqual({
      kind: 'unavailable',
      reason: 'credentials-unavailable',
    })
    expect(onboardingReadiness(state({
      rows: [row({ credential: undefined })],
    }))).toEqual({ kind: 'unavailable', reason: 'credentials-unavailable' })
    expect(onboardingReadiness(state({
      rows: [row({ credential: { configured: false, writable: false } })],
    }))).toEqual({ kind: 'unavailable', reason: 'credential-read-only' })
    expect(onboardingReadiness(state({ writable: false }))).toEqual({
      kind: 'unavailable',
      reason: 'settings-read-only',
    })
  })
})
