/** The shipped Web composition must activate the login flows its Models page offers. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

it('mounts authorization beside the pi-ai adapter and account Remote controller', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const entries = composeEntries(['base', 'web-app'].map(name =>
    loadOverlayPatches('web authorization test', join(root, 'packages', 'bundle', name, 'cordis.patch.yml'))))
  for (const name of ['@deepseek-ai/dsh-authorization', '@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-api-settings-controller']) {
    const active = entries.filter(entry => entry.name === name && entry.disabled !== true)
    expect(active, name).toHaveLength(1)
  }
})
