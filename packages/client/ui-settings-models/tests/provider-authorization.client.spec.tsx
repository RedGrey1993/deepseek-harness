// @vitest-environment jsdom
/** Account interaction stays local to its card and cancels when that card closes. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderAuthorizationFrame, ProviderAuthorizationState, AuthorizationAttemptId, AuthorizationPromptId } from '@deepseek-ai/dsh-api-remotes/client'
import { ProviderAuthorization, authorizationUrl } from '../src/client/ProviderAuthorization.tsx'
import type { ModelsOperations } from '../src/client/operations.ts'
import { createModelsOperations } from '../src/client/operations.ts'
import { providerUsable } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const state: ProviderAuthorizationState = {
  available: true, configured: false, nativeConfigured: false, inFlight: false, writable: true,
  methods: [{ id: 'oauth', label: 'ChatGPT' }],
}

function fixture(local = true, provider = 'openai-codex', account = state) {
  let receive: ((frame: ProviderAuthorizationFrame) => void) | undefined
  let signal: AbortSignal | undefined
  let settle: (() => void) | undefined
  const remote = {
    $host: { isLoopback: local },
    authorization: {
      describe: vi.fn(async () => ({ ok: true, value: account })),
      answer: vi.fn(async () => ({ ok: true, value: undefined })),
      logout: vi.fn(async () => ({ ok: true, value: undefined })),
    },
  }
  const operations = createModelsOperations({ remote } as never)
  const login = vi.fn<ModelsOperations['loginAuthorization']>(async (_provider, _method, abortSignal, callback) => {
    signal = abortSignal
    receive = callback
    await new Promise<void>((resolve) => {
      settle = resolve
      abortSignal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  })
  operations.loginAuthorization = login
  const changed = vi.fn()
  const props = { provider, operations, t: (key: keyof typeof en) => en[key],
    readOnly: false, overridden: false, onChanged: changed }
  return { props, remote, changed, login,
    send: (frame: ProviderAuthorizationFrame) => { receive?.(frame) },
    finish: () => { settle?.() }, aborted: () => signal?.aborted }
}

async function start(f: ReturnType<typeof fixture>) {
  const view = render(<ProviderAuthorization {...f.props} />)
  const button = screen.getByRole('button', { name: en.oauthSignIn })
  await waitFor(() => { expect(button.hasAttribute('disabled')).toBe(false) })
  fireEvent.click(button)
  act(() => { f.send({ type: 'started', attemptId: 'attempt-a' as AuthorizationAttemptId }) })
  return view
}

describe('provider authorization', () => {
  it('shows URL and device code, forwards prompt answers, and refreshes only after success', async () => {
    const f = fixture()
    const view = await start(f)
    act(() => {
      f.send({ type: 'notice', message: 'Authorize this account', url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234' })
      f.send({ type: 'prompt', promptId: 'prompt-a' as AuthorizationPromptId, prompt: { kind: 'text', message: 'Paste callback code' } })
    })
    expect(screen.getByRole('link', { name: en.oauthOpenPage }).getAttribute('href')).toBe('https://auth.openai.com/codex/device')
    expect(screen.getByText('ABCD-1234')).toBeTruthy()
    expect(view.container.textContent).toMatchSnapshot()
    expect(f.changed).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Paste callback code'), { target: { value: 'one-time-code' } })
    fireEvent.click(screen.getByRole('button', { name: en.oauthContinue }))
    await waitFor(() => { expect(f.remote.authorization.answer).toHaveBeenCalledWith('attempt-a', 'prompt-a', 'one-time-code') })
    act(() => { f.send({ type: 'outcome', status: 'authorized' }); f.finish() })
    await waitFor(() => { expect(f.changed).toHaveBeenCalledOnce() })
    expect(screen.queryByText('ABCD-1234')).toBeNull()
    expect(screen.getByText(en.oauthSaved)).toBeTruthy()
  })

  it('retains the xAI device URL and code during progress without requiring a callback prompt', async () => {
    const f = fixture(true, 'xai', { ...state, methods: [
      { id: 'oauth', label: 'Sign in with SuperGrok or X Premium' },
      { id: 'api-key', label: 'xAI API key' },
    ] })
    const view = await start(f)
    act(() => {
      f.send({ type: 'notice', message: 'Authorize xAI', url: 'https://auth.x.ai/device', code: 'XAI-1234' })
      f.send({ type: 'notice', message: 'Waiting for authorization' })
    })
    expect(f.login).toHaveBeenCalledWith('xai', 'oauth', expect.any(AbortSignal), expect.any(Function))
    expect(screen.getByRole('link', { name: en.oauthOpenPage }).getAttribute('href')).toBe('https://auth.x.ai/device')
    expect(screen.getByText('XAI-1234')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByText(/ChatGPT/)).toBeNull()
    expect(view.container.textContent).toMatchSnapshot()
    act(() => { f.send({ type: 'outcome', status: 'authorized' }); f.finish() })
    await waitFor(() => { expect(f.changed).toHaveBeenCalledOnce() })
    expect(screen.getByText(en.oauthSaved)).toBeTruthy()
  })

  it('withdraws a callback prompt without cancelling the login', async () => {
    const f = fixture()
    await start(f)
    act(() => { f.send({ type: 'prompt', promptId: 'p' as AuthorizationPromptId, prompt: { kind: 'secret', message: 'Code' } }) })
    expect(screen.getByLabelText('Code').getAttribute('type')).toBe('password')
    act(() => { f.send({ type: 'withdrawn', promptId: 'p' as AuthorizationPromptId }) })
    expect(screen.queryByLabelText('Code')).toBeNull()
    expect(f.aborted()).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    await waitFor(() => { expect(f.aborted()).toBe(true); expect(screen.getByText(en.oauthCancelled)).toBeTruthy() })
  })

  it('aborts on unmount and ignores late success', async () => {
    const f = fixture()
    const view = await start(f)
    view.unmount()
    expect(f.aborted()).toBe(true)
    await act(async () => { f.send({ type: 'outcome', status: 'authorized' }); f.finish() })
    expect(f.changed).not.toHaveBeenCalled()
  })

  it('does not start account requests from remote browsers', () => {
    const f = fixture(false)
    render(<ProviderAuthorization {...f.props} />)
    expect(screen.getByText(en.oauthLocalOnly)).toBeTruthy()
    expect(f.remote.authorization.describe).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: en.oauthSignIn })).toBeNull()
  })

  it('reports a broken stream and allows retry', async () => {
    const f = fixture()
    f.props.operations.loginAuthorization = vi.fn(async () => { throw new Error('Network unavailable') })
    await start(f)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('Network unavailable') })
    expect(screen.getByRole('button', { name: en.oauthSignIn }).hasAttribute('disabled')).toBe(false)
  })

  it('keeps explicit credential overrides visible and refuses a misleading sign-in', async () => {
    const f = fixture()
    render(<ProviderAuthorization {...f.props} overridden />)
    await waitFor(() => { expect(screen.getByText(en.oauthDisconnected)).toBeTruthy() })
    expect(screen.getByText(en.oauthOverride)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.oauthSignIn }).hasAttribute('disabled')).toBe(true)
  })

  it('signs out without deleting model settings', async () => {
    const f = fixture()
    f.remote.authorization.describe.mockResolvedValue({ ok: true, value: { ...state, configured: true } })
    render(<ProviderAuthorization {...f.props} />)
    fireEvent.click(await screen.findByRole('button', { name: en.oauthSignOut }))
    await waitFor(() => { expect(f.remote.authorization.logout).toHaveBeenCalledWith('openai-codex'); expect(f.changed).toHaveBeenCalledOnce() })
  })

  it('refreshes a busy state after another page finishes sign-in', async () => {
    const f = fixture()
    f.remote.authorization.describe.mockResolvedValueOnce({ ok: true, value: { ...state, inFlight: true } })
    render(<ProviderAuthorization {...f.props} />)
    await screen.findByText(en.oauthInFlight)
    expect(screen.getByRole('button', { name: en.oauthSignIn }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.oauthRefresh }))
    await waitFor(() => { expect(screen.getByRole('button', { name: en.oauthSignIn }).hasAttribute('disabled')).toBe(false) })
  })

  it('does not render active content as a sign-in link', () => {
    expect(authorizationUrl('javascript:alert(1)')).toBeUndefined()
    expect(authorizationUrl('data:text/html,hello')).toBeUndefined()
    expect(authorizationUrl('invalid url')).toBeUndefined()
  })

  it('requires a stored grant before a keyless Codex route is usable', () => {
    const row = { entry: { provider: 'openai-codex', displayName: 'Codex', settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai-codex'], active: true }, configured: true,
    removable: true, apiKeyEnv: undefined, credential: undefined }
    expect(providerUsable(row)).toBe(false)
    expect(providerUsable({ ...row, authorization: { ...state, configured: true } })).toBe(true)
    expect(providerUsable({ ...row, apiKeyEnv: 'CODEX_TOKEN', credential: { configured: true, writable: true } })).toBe(true)
  })
})
