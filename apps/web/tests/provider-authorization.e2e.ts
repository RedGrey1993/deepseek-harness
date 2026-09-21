/** Real Web composition and pi-ai device login, with only external xAI HTTP responses scripted. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'
import {
  installXaiOAuthFixture, XAI_ACCESS_TOKEN, XAI_USER_CODE, XAI_VERIFICATION_URL,
} from './xai-oauth-fixture.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/provider-authorization', import.meta.url))
const MODE = webSnapshotMode()

// Record mode mounts a live model adapter and is not needed for account-only traffic.
describe.skipIf(MODE === 'record')('web e2e: provider capabilities drive account sign-in', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let external: ReturnType<typeof installXaiOAuthFixture> | undefined
  const originalKey = process.env['XAI_API_KEY']

  beforeAll(async () => {
    delete process.env['XAI_API_KEY']
    external = installXaiOAuthFixture()
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  })

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      try { await scaffold?.close() } finally {
        external?.restore()
        if (originalKey === undefined) delete process.env['XAI_API_KEY']
        else process.env['XAI_API_KEY'] = originalKey
      }
    }
  })

  it('authorizes xAI by device code, retains API-key choice, and keeps Codex OAuth-only', async () => {
    if (scaffold === undefined || external === undefined) throw new Error('OAuth browser fixture did not start')
    const host = scaffold
    const auth = external
    onTestFailed(() => saveFailureShot(page, 'web-e2e-provider-authorization'))
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Models', exact: true }).click()
    const add = settings.getByRole('button', { name: 'Add provider', exact: true })
    await expect.poll(() => add.isEnabled()).toBe(true)
    await add.click()
    const provider = settings.getByLabel('Provider', { exact: true })
    await provider.selectOption('xai')
    const signIn = settings.getByRole('button', { name: 'Sign in', exact: true })
    await expect.poll(() => signIn.isEnabled()).toBe(true)
    await settings.getByText('Sign in with SuperGrok or X Premium', { exact: true }).waitFor()
    const key = settings.getByLabel('API key', { exact: true })
    await key.waitFor()
    expect(await settings.textContent()).not.toContain('ChatGPT')
    await key.fill('fixture-explicit-key')
    await expect.poll(() => signIn.isDisabled()).toBe(true)
    await key.fill('')
    await expect.poll(() => signIn.isEnabled()).toBe(true)
    await signIn.click()
    await settings.getByText(XAI_USER_CODE, { exact: true }).waitFor()
    await expect.poll(() => auth.counts().tokenRequests).toBe(1)
    expect(await settings.getByRole('link', { name: 'Open authorization page' }).getAttribute('href'))
      .toBe(XAI_VERIFICATION_URL)
    expect(await settings.locator('input:visible').count()).toBe(1)
    expect(await settings.getByRole('button', { name: 'Continue', exact: true }).count()).toBe(0)
    expect(await settings.textContent()).not.toContain('ChatGPT')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'xai-device.expected.md'),
      await captureStableAria(page, '[role="dialog"]', host.workspaceCwd), MODE)

    auth.approve()
    await settings.getByRole('button', { name: 'Sign out', exact: true }).waitFor()
    await settings.getByText('Signed in. Apply to save the provider settings.', { exact: true }).waitFor()
    const credentialFile = join(host.harnessHome, '.credentials.yaml')
    expect(await readFile(credentialFile, 'utf8')).toContain(XAI_ACCESS_TOKEN)
    expect(await page.content()).not.toContain(XAI_ACCESS_TOKEN)
    expect(await page.content()).not.toContain('fixture-private-device-code')
    await settings.getByRole('button', { name: 'Apply', exact: true }).click()
    await settings.getByRole('img', { name: 'Signed in', exact: true }).waitFor()
    const document = await readFile(join(host.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('xai: {}')
    expect(document).not.toContain('XAI_API_KEY')
    await settings.getByRole('button', { name: 'Edit xai', exact: true }).click()
    await settings.getByRole('button', { name: 'Sign out', exact: true }).click()
    await settings.getByText('Not signed in', { exact: true }).waitFor()
    await settings.getByRole('img', { name: 'Not signed in', exact: true }).waitFor()
    expect(await readFile(credentialFile, 'utf8')).not.toContain(XAI_ACCESS_TOKEN)
    expect(await readFile(join(host.harnessHome, 'settings.yaml'), 'utf8')).toBe(document)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'xai-signed-out.expected.md'),
      await captureStableAria(page, '[role="dialog"]', host.workspaceCwd), MODE)

    await signIn.click()
    await settings.getByText(XAI_USER_CODE, { exact: true }).waitFor()
    await expect.poll(() => auth.counts().tokenRequests).toBe(2)
    // The last Cancel belongs to the editor, so closing it cancels its active stream.
    await settings.getByRole('button', { name: 'Cancel', exact: true }).last().click()
    await expect.poll(() => auth.counts().cancelledRequests).toBe(1)
    expect(await readFile(credentialFile, 'utf8')).not.toContain(XAI_ACCESS_TOKEN)

    await add.click()
    await provider.selectOption('openai-codex')
    await expect.poll(() => signIn.isEnabled()).toBe(true)
    expect(await settings.getByLabel('API key', { exact: true }).count()).toBe(0)
    expect(await settings.textContent()).toContain('ChatGPT')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'codex-oauth-only.expected.md'),
      await captureStableAria(page, '[role="dialog"]', host.workspaceCwd), MODE)
    expect(auth.counts()).toEqual({ deviceRequests: 2, tokenRequests: 2, cancelledRequests: 1 })
    expect(tripwire.pageErrors).toEqual([])
  })

  it('keeps the account fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'codex-oauth-only.expected.md', 'xai-device.expected.md', 'xai-signed-out.expected.md',
    ])
  })
})
