/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A provider authorization refusal; no credentials or prompt answers are returned. */
    'authorization/rejected': { readonly provider: string }
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because a
     * read-only source shadows the reference. The details name only the
     * reference, never the value.
     */
    'credential/rejected': { readonly ref: string }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}
/** Unpredictable capability identifying the browser that started one sign-in. */
export type AuthorizationAttemptId = Branded<'AuthorizationAttemptId'>
/** Identity of one pending question in an authorization attempt. */
export type AuthorizationPromptId = Branded<'AuthorizationPromptId'>

/** Public sign-in availability and credential presence for one built-in provider. */
export interface ProviderAuthorizationState {
  /** Whether the Host can run this provider's registered sign-in flow. */
  readonly available: boolean
  /** Whether a provider-owned credential record is stored, even without a sign-in flow. */
  readonly configured: boolean
  /** Whether the provider detected native credentials without a stored account record; not a remote validity test. */
  readonly nativeConfigured: boolean
  readonly writable: boolean
  readonly inFlight: boolean
  readonly methods: readonly { readonly id: string; readonly label: string }[]
}

/** A browser question, with host-only cancellation signals removed. */
export type ProviderAuthorizationPrompt =
  | { readonly kind: 'text' | 'secret'; readonly message: string; readonly placeholder?: string }
  | {
    readonly kind: 'select'
    readonly message: string
    readonly options: readonly {
      readonly id: string
      readonly label: string
      readonly description?: string
    }[]
  }

/** Frames delivered only to the caller that starts sign-in. */
export type ProviderAuthorizationFrame =
  | { readonly type: 'started'; readonly attemptId: AuthorizationAttemptId }
  | { readonly type: 'notice'; readonly message: string; readonly url?: string; readonly code?: string }
  | { readonly type: 'prompt'; readonly promptId: AuthorizationPromptId; readonly prompt: ProviderAuthorizationPrompt }
  | { readonly type: 'withdrawn'; readonly promptId: AuthorizationPromptId }
  | { readonly type: 'outcome'; readonly status: 'authorized' | 'cancelled' }
