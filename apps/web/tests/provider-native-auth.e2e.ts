/** Real Web composition distinguishes native credentials from a missing authorization plugin. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { credentialKeyScope, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed, vi } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'
import { installKimiNativeFixture, KIMI_MESSAGES_URL, KIMI_NATIVE_KEY, KIMI_REPLY } from './kimi-native-fixture.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/provider-native-auth', import.meta.url))
const MODE = webSnapshotMode()
const ONBOARDING = 'Add an API key to get started'

describe.skipIf(MODE === 'record')('web e2e: provider-native credentials and unavailable authorization', () => {
  let root: string | undefined
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let external: ReturnType<typeof installKimiNativeFixture> | undefined

  afterEach(async () => {
    try {
      await browser?.close()
    } finally {
      try {
        await scaffold?.close()
      } finally {
        external?.restore()
        vi.unstubAllEnvs()
        if (root !== undefined) await rm(root, { recursive: true, force: true })
        root = undefined
        scaffold = undefined
        browser = undefined
        page = undefined
        external = undefined
      }
    }
  })

  async function start(provider: 'kimi-coding' | 'openai-codex', authorizationDisabled = false) {
    root = await mkdtemp(join(tmpdir(), 'dsh-provider-native-'))
    const overlay = join(root, 'provider.overlay.yml')
    await writeFile(overlay, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      `      ${provider}: {}`,
      '- id: agent-default-model',
      '  config:',
      `    provider: ${provider}`,
      `    model: ${provider === 'kimi-coding' ? 'kimi-for-coding' : 'gpt-5.4'}`,
      ...authorizationDisabled ? ['- id: authorization', '  disabled: true'] : [],
      '',
    ].join('\n'))
    vi.stubEnv('KIMI_API_KEY', provider === 'kimi-coding' ? KIMI_NATIVE_KEY : undefined)
    for (const name of ['KIMI_CODING_API_KEY', 'OPENAI_CODEX_API_KEY', 'OPENAI_API_KEY']) vi.stubEnv(name, undefined)
    external = installKimiNativeFixture()
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true, extraOverlayPath: overlay })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    const currentPage = page
    const host = scaffold
    const network = external
    const tripwire = watchConsole(currentPage)
    const browserExternal: string[] = []
    await currentPage.route('**/*', async (route) => {
      const url = route.request().url()
      if (new URL(url).origin === host.baseUrl) return route.continue()
      browserExternal.push(url)
      await route.abort('blockedbyclient')
    })
    onTestFailed(() => saveFailureShot(currentPage, `web-e2e-native-${provider}`))
    await currentPage.goto(host.authenticatedUrl, { waitUntil: 'load' })
    await currentPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    return { host, page: currentPage, network, tripwire, browserExternal }
  }

  it('skips DeepSeek onboarding with only KIMI_API_KEY and sends the native key through the real adapter', async () => {
    const { host, page, network, tripwire, browserExternal } = await start('kimi-coding')
    expect(host.ctx.llm.listProviders().map(provider => provider.id)).toContain('kimi-coding')
    await expect(host.ctx.credentials.describe(credentialRef('DEEPSEEK_API_KEY'))).resolves.toMatchObject({ configured: false })
    await expect(host.ctx.credentials.describe(credentialRef('KIMI_CODING_API_KEY'))).resolves.toMatchObject({ configured: false })
    expect((await host.ctx.credentials.listRecords()).filter(record => credentialKeyScope(record.key) === 'llm-pi-ai'))
      .toEqual([])

    // A successful Settings click requires completed onboarding, not just a momentary absence of its dialog.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Models', exact: true }).click()
    await settings.getByRole('button', { name: 'Edit kimi-coding', exact: true }).waitFor()
    await settings.getByRole('button', { name: 'Edit DeepSeek (deepseek-official)', exact: true }).waitFor()
    await settings.getByRole('img', { name: 'Authentication configured', exact: true }).waitFor()
    expect(await page.getByRole('dialog', { name: ONBOARDING }).count()).toBe(0)
    expect(await settings.getByRole('img', { name: 'Signed in', exact: true }).count()).toBe(0)
    expect(await settings.getByLabel('API key', { exact: true }).count()).toBe(0)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'kimi-native.expected.md'),
      await captureStableAria(page, '[role="dialog"]', host.workspaceCwd), MODE)

    const settingsBefore = await readFile(join(host.harnessHome, 'settings.yaml'), 'utf8')
    expect(settingsBefore).not.toContain('apiKeyEnv')
    const assembler = new BlockAssembler()
    for await (const chunk of host.ctx.llm.stream({
      provider: 'kimi-coding', model: 'kimi-for-coding', maxTokens: 32,
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Reply with a short acknowledgement. Do not call tools.' }],
        source: { kind: 'plugin', plugin: 'native-auth-browser-test' },
      })],
    })) assembler.push(chunk)
    expect(assembler.finish).toEqual({ kind: 'stop' })
    expect(assembler.message({ kind: 'model', provider: 'kimi-coding', model: 'kimi-for-coding' }).content)
      .toEqual([{ type: 'text', text: KIMI_REPLY }])
    expect(network.requests).toHaveLength(1)
    expect(network.requests[0]).toMatchObject({
      url: KIMI_MESSAGES_URL, method: 'POST', key: KIMI_NATIVE_KEY,
      body: { model: 'kimi-for-coding', stream: true },
    })
    expect((await host.ctx.credentials.listRecords()).filter(record => credentialKeyScope(record.key) === 'llm-pi-ai'))
      .toEqual([])
    expect(await readFile(join(host.harnessHome, 'settings.yaml'), 'utf8')).toBe(settingsBefore)
    expect(await page.content()).not.toContain(KIMI_NATIVE_KEY)
    expect(network.unexpected).toEqual([])
    expect(browserExternal).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })

  it('keeps DeepSeek onboarding when a custom overlay disables authorization and Codex has no grant', async () => {
    const { host, page, network, tripwire, browserExternal } = await start('openai-codex', true)
    expect(host.ctx.get('authorization')).toBeUndefined()
    expect(host.ctx.llm.listProviders().map(provider => provider.id)).toContain('openai-codex')
    expect((await host.ctx.credentials.listRecords()).filter(record => credentialKeyScope(record.key) === 'llm-pi-ai'))
      .toEqual([])
    await expect(host.ctx.credentials.describe(credentialRef('DEEPSEEK_API_KEY'))).resolves.toMatchObject({ configured: false })
    const onboarding = page.getByRole('dialog', { name: ONBOARDING })
    await onboarding.waitFor()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'codex-unavailable-onboarding.expected.md'),
      await captureStableAria(page, '[role="dialog"]', host.workspaceCwd), MODE)
    await onboarding.getByRole('button', { name: 'Configure later', exact: true }).click()
    await onboarding.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Models', exact: true }).click()
    await settings.getByRole('button', { name: 'Edit openai-codex', exact: true }).click()
    await settings.getByText('The Host has no sign-in flow for this provider.', { exact: true }).waitFor()
    expect(await settings.getByRole('button', { name: 'Sign in', exact: true }).count()).toBe(0)
    expect(await settings.getByRole('img', { name: 'Signed in', exact: true }).count()).toBe(0)
    expect(await settings.getByRole('img', { name: 'Authentication configured', exact: true }).count()).toBe(0)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'codex-unavailable-settings.expected.md'),
      await captureStableAria(page, '[role="dialog"]', host.workspaceCwd), MODE)
    expect(network.requests).toEqual([])
    expect(network.unexpected).toEqual([])
    expect(browserExternal).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  })

  it('keeps the native-authorization fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'kimi-native.expected.md', 'codex-unavailable-onboarding.expected.md', 'codex-unavailable-settings.expected.md',
    ])
  })
})
