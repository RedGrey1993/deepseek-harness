/** Source-launch fixture that runs a real agent turn through Loader-owned services. */

import { writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-cmdline'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../../packages/core/agent-loop/tests/mock-adapter.ts'

export const inject = ['llm', 'tools', 'agentLoop', 'appReady', 'appExit']

export function apply(ctx: Context, config: { marker: string; events: string }): void {
  ctx.effect(() => ctx.llm.registerAdapter(['source-launch'], new MockAdapter([
    toolCallResponse('source-call', 'write_marker', {}),
    textResponse('completed'),
  ])))
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({
    name: 'write_marker',
    description: 'Write the source-launch marker.',
    parameters: {},
    async execute() {
      await writeFile(config.marker, 'tool executed\n')
      return [{ type: 'text', text: 'written' }]
    },
  })))
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  if (ready === undefined || exit === undefined) throw new Error('source-launch fixture requires the dsh launcher')
  ctx.effect(() => ready.onReady(() => {
    void run().then(() => exit(0), (error: unknown) => {
      process.stderr.write(`${String(error)}\n`)
      exit(1)
    })
  }))

  async function run(): Promise<void> {
    const agent = await ctx.agentLoop.create(SessionId('source-launch'), { provider: 'source-launch', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'write the marker' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
      .filter(event => event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'turn/end')
    await writeFile(config.events, JSON.stringify(events))
  }
}
