import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

/**
 * Keyless smoke for SOURCE `dsh` execution: run `apps/cli/src/bin.ts`
 * with the exact production runtime vector (`node --import tsx/esm`, the
 * vector the root `dsh` script invokes directly). Source-path resolution must
 * keep Loader plugins and their imported service APIs in one module graph. The Node compatibility matrix runs this
 * WHOLE file, so a Node release changing module hooks or TypeScript handling
 * breaks this gate instead of every developer's `pnpm dsh`; the built-bin
 * suite covers the published `lib/` entry, not this source chain.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const dshSourceBin = 'apps/cli/src/bin.ts'

describe('dsh SOURCE launcher (node --import tsx/esm)', () => {
  it('launches the source CLI without building', async () => {
    const rootPackage = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      readonly scripts?: Record<string, string>
    }
    expect(rootPackage.scripts?.dsh).toBe('node --import tsx/esm apps/cli/src/bin.ts')
  })

  it('boots the source entry and requires a profile', async () => {
    const result = await execa(process.execPath, ['--import', 'tsx/esm', dshSourceBin], {
      cwd: repoRoot,
      input: '',
      timeout: 25_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    if (result.timedOut) {
      throw new Error(`dsh source launch did not exit within 25s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('--profile <name> is required')
    expect(result.stdout).toBe('')
  }, 30_000)

  it('loads profile services from source and completes a tool turn', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-source-profile-'))
    try {
      const profile = join(home, 'profiles', 'source-launch')
      const marker = join(home, 'marker.txt')
      const events = join(home, 'events.json')
      await mkdir(profile, { recursive: true })
      await writeFile(join(profile, 'package.json'), JSON.stringify({
        name: 'source-launch-profile', private: true, dsh: { profile: { bundles: [] } },
      }))
      const services = ['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop']
      await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [
        ...services.map(name => ({ id: name, name: `@deepseek-ai/dsh-${name}`, config: name === 'agent-loop' ? { agents: [] } : {} })),
        {
          id: 'source-launch-fixture',
          name: new URL('./profiles/source-launch/fixture.ts', import.meta.url).href,
          config: { marker, events },
        },
      ] }]))
      const result = await execa(process.execPath, ['--import', 'tsx/esm', dshSourceBin, '--profile', 'source-launch'], {
        cwd: repoRoot,
        env: { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
        input: '',
        timeout: 60_000,
        killSignal: 'SIGKILL',
        reject: false,
      })
      expect(result.timedOut, result.stderr).toBe(false)
      expect(result.signal, result.stderr).toBeUndefined()
      expect(result.exitCode, result.stderr).toBe(0)
      expect(await readFile(marker, 'utf8')).toBe('tool executed\n')
      const recorded: unknown = JSON.parse(await readFile(events, 'utf8'))
      expect(recorded).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'tool/call', data: expect.objectContaining({ name: 'write_marker' }) }),
        expect.objectContaining({ type: 'tool/result' }),
        expect.objectContaining({ type: 'turn/end', data: expect.objectContaining({ reason: { kind: 'completed' } }) }),
      ]))
    } finally {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, 75_000)

})
