/** Caller-owned provider sign-in over the existing authorization and credential services. */
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { AuthorizationPrompt, AuthorizationService } from '@deepseek-ai/dsh-authorization'
import { credentialKey, isCredentialKeySegment } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AuthorizationAttemptId, AuthorizationPromptId, ProviderAuthorizationFrame,
  ProviderAuthorizationPrompt, ProviderAuthorizationState,
} from './types.ts'

interface PendingPrompt {
  readonly resolve: (value: string) => void
  readonly reject: (error: Error) => void
  readonly prompt: ProviderAuthorizationPrompt
}

interface Attempt {
  readonly controller: AbortController
  readonly prompts: Map<AuthorizationPromptId, PendingPrompt>
  done?: Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the caller-private provider authorization Remote namespace. */
    authorizationController: AuthorizationController
  }
}

/** Host service exposing built-in provider sign-in without exposing stored tokens. */
export class AuthorizationController extends TypertRemoteService {
  private readonly attempts = new Map<AuthorizationAttemptId, Attempt>()
  private readonly lifetime = new AbortController()

  /** @param ctx - Host context where credential and authorization services may be mounted. */
  constructor(ctx: Context) {
    super(ctx, 'authorizationController', { namespace: 'authorization' })
    ctx.effect(() => async () => {
      this.lifetime.abort()
      for (const attempt of this.attempts.values()) attempt.controller.abort()
      await Promise.all([...this.attempts.values()].flatMap(attempt => attempt.done === undefined ? [] : [attempt.done]))
    }, 'authorization-controller.attempts')
  }

  /**
   * Describe sign-in methods and stored credential presence without reading a token.
   * @param provider - installed pi-ai provider identifier, never a scoped record key.
   * @returns safe credential metadata and available sign-in methods.
   */
  @Remote
  async describe(provider: string): Promise<ProviderAuthorizationState> {
    const key = providerKey(provider)
    const authorization = this.ctx.get('authorization')
    const credentials = this.ctx.get('credentials')
    const entry = authorization?.describe(key)
    if (entry === undefined || credentials === undefined) {
      return { available: false, configured: false, writable: false, inFlight: false, methods: [] }
    }
    const info = await credentials.describeRecord(key)
    return {
      available: true, configured: info.configured, writable: info.writable, inFlight: entry.inFlight,
      methods: entry.methods.map(method => ({ id: method.id, label: method.label })),
    }
  }

  /**
   * Run a sign-in whose private notices and prompts belong to this stream only.
   * @param provider - installed pi-ai provider identifier.
   * @param method - method id returned by describe.
   * @param signal - closing the caller cancels sign-in and every pending question.
   * @returns private interaction frames followed by the authorization outcome.
   */
  @Remote({ mode: 'stream' })
  async *login(provider: string, method: string, signal: AbortSignal): AsyncIterable<ProviderAuthorizationFrame> {
    const key = providerKey(provider)
    const authorization = this.authorization()
    const credentials = this.credentials()
    if (!(await credentials.describeRecord(key)).writable) throw rejected(provider, 'Credential storage is read-only')
    const controller = new AbortController()
    const lifetime = AbortSignal.any([signal, this.lifetime.signal, controller.signal])
    const id = randomUUID() as AuthorizationAttemptId
    const attempt: Attempt = { controller, prompts: new Map() }
    const frames: ProviderAuthorizationFrame[] = []
    let wake: (() => void) | undefined
    const completion: { finished: boolean; failure?: unknown } = { finished: false }
    const enqueue = (frame: ProviderAuthorizationFrame): void => {
      if (lifetime.aborted) return
      frames.push(frame)
      wake?.()
    }
    const cancel = (): void => {
      for (const prompt of attempt.prompts.values()) prompt.reject(new Error('Authorization was cancelled'))
      wake?.()
    }
    lifetime.addEventListener('abort', cancel, { once: true })
    this.attempts.set(id, attempt)
    const running = authorization.begin({
      key, method, signal: lifetime,
      interaction: {
        notify: (notice) => { enqueue({ type: 'notice', message: notice.message,
          ...notice.url === undefined ? {} : { url: notice.url },
          ...notice.code === undefined ? {} : { code: notice.code } }) },
        prompt: prompt => this.prompt(attempt, prompt, lifetime, enqueue),
      },
    }).then((outcome) => { enqueue({ type: 'outcome', status: outcome.status }) }, (error: unknown) => {
      completion.failure = error
    }).finally(() => { completion.finished = true; wake?.() })
    attempt.done = running
    try {
      yield { type: 'started', attemptId: id }
      while (!lifetime.aborted) {
        const frame = frames.shift()
        if (frame !== undefined) { yield frame; continue }
        if (completion.finished) break
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
      if (completion.failure !== undefined) throw rejected(provider, 'Sign-in failed; retry authorization', completion.failure)
    } finally {
      controller.abort()
      lifetime.removeEventListener('abort', cancel)
      this.attempts.delete(id)
      await running
    }
  }

  /**
   * Answer one pending question; stale or foreign capabilities cannot answer it.
   * @param attemptId - private capability from the started frame.
   * @param promptId - identity from the matching prompt frame.
   * @param value - typed value or the id of a declared select option.
   */
  @Remote
  answer(attemptId: AuthorizationAttemptId, promptId: AuthorizationPromptId, value: string): void {
    const pending = this.attempts.get(attemptId)?.prompts.get(promptId)
    if (pending === undefined) throw new RemoteError('gateway/bad-request', 'Authorization question is no longer pending', {})
    if (pending.prompt.kind === 'select' && !pending.prompt.options.some(option => option.id === value)) {
      throw new RemoteError('gateway/bad-request', 'Choose one of the offered authorization options', {})
    }
    pending.resolve(value)
  }

  /**
   * Remove only the credential owned by the selected built-in provider.
   * @param provider - installed pi-ai provider identifier.
   * @returns after the credential has been removed.
   */
  @Remote
  async logout(provider: string): Promise<void> {
    const key = providerKey(provider)
    const entry = this.authorization().describe(key)
    if (entry === undefined) throw rejected(provider, 'No sign-in flow is registered for this provider')
    if (entry.inFlight) throw rejected(provider, 'Cancel the current sign-in before signing out')
    try {
      await this.credentials().deleteRecord(key)
    } catch (error) {
      throw rejected(provider, 'Could not remove the stored credential', error)
    }
  }

  private prompt(
    attempt: Attempt, prompt: AuthorizationPrompt, signal: AbortSignal,
    enqueue: (frame: ProviderAuthorizationFrame) => void,
  ): Promise<string> {
    const promptSignal = prompt.signal === undefined ? signal : AbortSignal.any([signal, prompt.signal])
    if (promptSignal.aborted) return Promise.reject(new Error('Authorization question was withdrawn'))
    const id = randomUUID() as AuthorizationPromptId
    const view = promptView(prompt)
    return new Promise<string>((resolve, reject) => {
      const cleanup = (): void => {
        attempt.prompts.delete(id)
        promptSignal.removeEventListener('abort', withdraw)
      }
      const withdraw = (): void => {
        cleanup()
        enqueue({ type: 'withdrawn', promptId: id })
        reject(new Error('Authorization question was withdrawn'))
      }
      attempt.prompts.set(id, {
        prompt: view,
        resolve: (value) => { cleanup(); resolve(value) },
        reject: (error) => { cleanup(); reject(error) },
      })
      promptSignal.addEventListener('abort', withdraw, { once: true })
      enqueue({ type: 'prompt', promptId: id, prompt: view })
    })
  }

  private authorization(): AuthorizationService {
    const authorization = this.ctx.get('authorization')
    if (authorization === undefined) throw new RemoteError('gateway/internal', 'This deployment has no authorization service', {})
    return authorization
  }

  private credentials(): CredentialProvider {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) throw new RemoteError('gateway/internal', 'This deployment has no credential storage', {})
    return credentials
  }
}

function providerKey(provider: string) {
  if (!isCredentialKeySegment(provider)) throw new RemoteError('gateway/bad-request', 'Invalid built-in provider identifier', {})
  return credentialKey('llm-pi-ai', provider)
}

function rejected(provider: string, message: string, cause?: unknown): RemoteError {
  return new RemoteError('authorization/rejected', message, { provider }, { cause })
}

function promptView(prompt: AuthorizationPrompt): ProviderAuthorizationPrompt {
  if (prompt.kind === 'select') return {
    kind: 'select', message: prompt.message,
    options: prompt.options.map(option => ({ id: option.id, label: option.label,
      ...option.description === undefined ? {} : { description: option.description } })),
  }
  return { kind: prompt.kind, message: prompt.message,
    ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder } }
}
