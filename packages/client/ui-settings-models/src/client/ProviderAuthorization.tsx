/** Account sign-in controls; each mounted card owns and cancels its login attempt. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ProviderAuthorizationFrame, ProviderAuthorizationState, AuthorizationAttemptId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsOperations } from './operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

type PromptFrame = Extract<ProviderAuthorizationFrame, { type: 'prompt' }>
type NoticeFrame = Extract<ProviderAuthorizationFrame, { type: 'notice' }>

interface Props {
  provider: string
  operations: ModelsOperations
  t: (key: keyof typeof en) => string
  readOnly: boolean
  overridden: boolean
  onChanged: () => void
}

/**
 * Accept only web URLs from provider notices; other schemes remain plain text.
 * @param value - provider-supplied authorization address.
 * @returns the safe address, or undefined.
 */
export function authorizationUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch { return undefined }
}

/**
 * Render the Codex account state and the active provider's sign-in conversation.
 * @param props - card-owned callbacks, identity, and localized copy.
 * @returns account controls and caller-private notices and prompts.
 */
export function ProviderAuthorization({ provider, operations, t, readOnly, overridden, onChanged }: Props): ReactNode {
  const [account, setAccount] = useState<ProviderAuthorizationState>()
  const [notice, setNotice] = useState<NoticeFrame>()
  const [prompt, setPrompt] = useState<PromptFrame>()
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [answering, setAnswering] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [outcome, setOutcome] = useState<'authorized' | 'cancelled'>()
  const attempt = useRef<{ controller: AbortController; id: AuthorizationAttemptId | undefined }>()
  const mounted = useRef(false)
  const local = operations.canAuthorize

  useEffect(() => {
    mounted.current = true
    let current = true
    setAccount(undefined)
    setFailure(undefined)
    if (local) {
      void operations.describeAuthorization(provider).then((value) => {
        if (current) setAccount(value)
      }).catch((error: unknown) => {
        if (current) setFailure(error instanceof Error ? error.message : String(error))
      })
    }
    return () => {
      current = false
      mounted.current = false
      attempt.current?.controller.abort()
      attempt.current = undefined
    }
  }, [provider, operations, local])

  const refresh = async (): Promise<void> => {
    const value = await operations.describeAuthorization(provider)
    if (!mounted.current) return
    setAccount(value)
    onChanged()
  }

  const refreshStatus = async (): Promise<void> => {
    setFailure(undefined)
    try { await refresh() } catch (error: unknown) {
      if (mounted.current) setFailure(error instanceof Error ? error.message : String(error))
    }
  }

  const login = async (): Promise<void> => {
    const method = account?.methods.find(candidate => candidate.id === 'oauth')
    if (method === undefined || attempt.current !== undefined) return
    const running = { controller: new AbortController(), id: undefined as AuthorizationAttemptId | undefined }
    attempt.current = running
    setBusy(true)
    setFailure(undefined)
    setOutcome(undefined)
    setNotice(undefined)
    setPrompt(undefined)
    setAnswer('')
    const result = { settled: false }
    try {
      await operations.loginAuthorization(provider, method.id, running.controller.signal, (frame) => {
        if (attempt.current !== running || running.controller.signal.aborted) return
        switch (frame.type) {
          case 'started': running.id = frame.attemptId; break
          case 'notice': setNotice(current => ({ ...current, ...frame })); break
          case 'prompt': setPrompt(frame); setAnswer(''); setAnswering(false); break
          case 'withdrawn':
            setPrompt(current => current?.promptId === frame.promptId ? undefined : current)
            setAnswer('')
            break
          case 'outcome': result.settled = true; setOutcome(frame.status); setPrompt(undefined); break
        }
      })
      if (!result.settled && !running.controller.signal.aborted) throw new Error(t('oauthInterrupted'))
    } catch (error: unknown) {
      if (attempt.current === running && !running.controller.signal.aborted) {
        setFailure(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (attempt.current === running) {
        attempt.current = undefined
        setBusy(false)
        setPrompt(undefined)
        setNotice(undefined)
        setAnswer('')
        setAnswering(false)
        if (running.controller.signal.aborted) setOutcome('cancelled')
        try { await refresh() } catch (error: unknown) {
          if (mounted.current) setFailure(error instanceof Error ? error.message : String(error))
        }
      }
    }
  }

  const submitAnswer = async (): Promise<void> => {
    const running = attempt.current
    if (running?.id === undefined || prompt === undefined || answering) return
    const question = prompt
    setAnswering(true)
    setFailure(undefined)
    try {
      await operations.answerAuthorization(running.id, question.promptId, answer)
      if (attempt.current !== running) return
      setPrompt(current => current?.promptId === question.promptId ? undefined : current)
      setAnswer('')
    } catch (error: unknown) {
      if (attempt.current === running) setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      if (attempt.current === running) setAnswering(false)
    }
  }

  const logout = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    setOutcome(undefined)
    try { await operations.logoutAuthorization(provider); await refresh() } catch (error: unknown) {
      if (mounted.current) setFailure(error instanceof Error ? error.message : String(error))
    } finally { if (mounted.current) setBusy(false) }
  }

  const link = authorizationUrl(notice?.url)
  const disabled = readOnly || busy || account?.writable !== true || account.inFlight
  return (
    <div className={styles['field']}>
      <span className={styles['fieldLabel']}>{t('oauthAccount')}</span>
      {!local ? <p className={styles['advancedHint']}>{t('oauthLocalOnly')}</p> : <>
        <p role="status" aria-live="polite">
          {busy ? t('oauthSigningIn') : account === undefined ? t('oauthLoading')
            : t(account.configured ? 'oauthConnected' : 'oauthDisconnected')}
        </p>
        {overridden ? <p className={styles['error']}>{t('oauthOverride')}</p> : null}
        {account?.available === false ? <p className={styles['error']}>{t('oauthUnavailable')}</p> : null}
        {account?.inFlight === true && !busy ? <p>{t('oauthInFlight')}</p> : null}
        <div className={styles['rowActions']}>
          <button type="button" className={styles['secondaryButton']} disabled={busy}
            onClick={() => { void refreshStatus() }}>{t('oauthRefresh')}</button>
          <button type="button" className={styles['secondaryButton']}
            disabled={disabled || overridden || !account.methods.some(method => method.id === 'oauth')}
            onClick={() => { void login() }}>{t('oauthSignIn')}</button>
          {account?.configured === true ? <button type="button" className={styles['dangerButton']}
            disabled={disabled} onClick={() => { void logout() }}>{t('oauthSignOut')}</button> : null}
          {busy && attempt.current !== undefined ? <button type="button" className={styles['secondaryButton']}
            onClick={() => { attempt.current?.controller.abort() }}>{t('cancel')}</button> : null}
        </div>
        {notice === undefined ? null : <div className={styles['oauthNotice']} role="status">
          <p>{notice.message}</p>
          {link === undefined ? null : <a href={link} target="_blank" rel="noopener noreferrer">{t('oauthOpenPage')}</a>}
          {link === undefined ? null : <div className={styles['oauthUrl']}>{link}</div>}
          {notice.code === undefined ? null : <p>{t('oauthCode')}: <code>{notice.code}</code></p>}
        </div>}
        {prompt === undefined ? null : <form onSubmit={(event) => { event.preventDefault(); void submitAnswer() }}>
          <label className={styles['field']}>
            <span>{prompt.prompt.message}</span>
            {prompt.prompt.kind === 'select'
              ? <select className={`${styles['input']} ${styles['selectInput']}`} value={answer} disabled={answering}
                onChange={(event) => { setAnswer(event.target.value) }}>
                <option value="">{t('oauthChoose')}</option>
                {prompt.prompt.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
              : <input className={styles['input']} type={prompt.prompt.kind === 'secret' ? 'password' : 'text'}
                value={answer} placeholder={prompt.prompt.placeholder} autoComplete="off" disabled={answering}
                onChange={(event) => { setAnswer(event.target.value) }} />}
          </label>
          <button type="submit" className={styles['secondaryButton']} disabled={answering || answer.length === 0}>
            {t('oauthContinue')}
          </button>
        </form>}
        {outcome === undefined ? null : <p role="status">{t(outcome === 'authorized' ? 'oauthSaved' : 'oauthCancelled')}</p>}
      </>}
      {failure === undefined ? null : <p role="alert" className={styles['error']}>{failure}</p>}
    </div>
  )
}
