/** Real Loader composition: browser sign-in commits through the local credential provider. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Authorization from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import SettingsController from '../src/index.ts'

it('loads sign-in from cordis.yml and persists only the provider grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-authorization-composition-'))
  const ctx = new Context()
  const key = credentialKey('llm-pi-ai', 'openai-codex')
  const credentialPath = join(root, '.credentials.yaml')
  const oauthProvider = {
    name: 'test-oauth-provider', inject: ['authorization', 'credentials'],
    apply(owner: Context) {
      owner.authorization.registerFlow({
        key, label: 'Codex', methods: [{ id: 'oauth', label: 'ChatGPT' }],
        async run(session) {
          session.notify({ message: 'Approve sign-in', url: 'https://auth.example/codex' })
          const code = await session.prompt({ kind: 'text', message: 'Paste callback' })
          if (code !== 'authorization-code') throw new Error('External OAuth code was refused')
          await owner.credentials.modifyRecord(key, () => Promise.resolve({
            kind: 'grant', payload: { type: 'oauth', access: 'stored-only-token', refresh: 'stored-only-refresh' },
          }))
        },
      })
    },
  }
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-credentials-local', CredentialsLocal],
    ['@deepseek-ai/dsh-authorization', Authorization],
    ['@deepseek-ai/dsh-api-settings-controller', SettingsController],
    ['test-oauth-provider', oauthProvider],
  ])
  try {
    await Promise.all([...modules.keys()].map(async (name) => {
      const directory = join(root, 'node_modules', ...name.split('/'))
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '0.1.0', type: 'module' }))
    }))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-credentials-local'",
      '  config:', `    path: ${JSON.stringify(credentialPath)}`,
      "- name: '@deepseek-ai/dsh-authorization'",
      "- name: '@deepseek-ai/dsh-api-settings-controller'",
      '- name: test-oauth-provider',
      '',
    ].join('\n'))
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const controller = ctx.authorizationController
    let attemptId: Parameters<typeof controller.answer>[0] | undefined
    const frames = []
    for await (const frame of controller.login('openai-codex', 'oauth', new AbortController().signal)) {
      frames.push(frame)
      if (frame.type === 'started') attemptId = frame.attemptId
      if (frame.type === 'prompt') {
        if (attemptId === undefined) throw new Error('Prompt arrived before attempt')
        controller.answer(attemptId, frame.promptId, 'authorization-code')
      }
    }
    expect(frames.at(-1)).toEqual({ type: 'outcome', status: 'authorized' })
    expect(JSON.stringify(frames)).not.toContain('stored-only')
    expect(await controller.describe('openai-codex')).toMatchObject({ configured: true, inFlight: false })
    expect(await readFile(credentialPath, 'utf8')).toContain('stored-only-token')
    await controller.logout('openai-codex')
    expect(await controller.describe('openai-codex')).toMatchObject({ configured: false })
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
