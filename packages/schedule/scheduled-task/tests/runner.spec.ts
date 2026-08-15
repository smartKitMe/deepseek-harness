import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { runScheduledTask, SCHEDULED_TASK_SOURCE } from '../src/runner.ts'
import type { ScheduledTaskRecord } from '../src/types.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

interface FakeAgent {
  id: SessionId
  session: { id: SessionId }
  followed: UserMessage[]
  followup(message: UserMessage): void
}

function record(overrides: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord {
  return {
    id: 'task-1' as ScheduledTaskRecord['id'],
    name: 'daily',
    prompt: 'summarize',
    schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' },
    model: { provider: 'p', model: 'm' },
    permission: 'workspace-write',
    conversation: { kind: 'new' },
    enabled: true,
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    ...overrides,
  }
}

function harness(): {
  ctx: Context
  created: { options: Record<string, unknown>; setup: ((c: Context) => unknown) | undefined }[]
  resumed: { options: Record<string, unknown>; setup: ((c: Context) => unknown) | undefined }[]
  agents: FakeAgent[]
  flushed: unknown[]
  permissionSet: { session: unknown; name: string }[]
  mountCalls: { ctx: Context; id: string | undefined }[]
} {
  const ctx = new Context()
  contexts.push(ctx)
  const created: { options: Record<string, unknown>; setup: ((c: Context) => unknown) | undefined }[] = []
  const resumed: { options: Record<string, unknown>; setup: ((c: Context) => unknown) | undefined }[] = []
  const agents: FakeAgent[] = []
  const flushed: unknown[] = []
  const permissionSet: { session: unknown; name: string }[] = []
  const mountCalls: { ctx: Context; id: string | undefined }[] = []

  const makeAgent = (id: SessionId): FakeAgent => {
    const agent: FakeAgent = {
      id,
      session: { id },
      followed: [],
      followup(message: UserMessage) { agent.followed.push(message) },
    }
    agents.push(agent)
    return agent
  }

  ctx.provide('agents', {
    async create(options: { sessionId: SessionId; setup?: (c: Context) => unknown }) {
      created.push({ options: { ...options }, setup: options.setup })
      const agent = makeAgent(options.sessionId)
      const agentCtx = new Context()
      contexts.push(agentCtx)
      await options.setup?.(agentCtx)
      return { agent }
    },
    async resume(options: { resumeSessionId: SessionId; setup?: (c: Context) => unknown }) {
      resumed.push({ options: { ...options }, setup: options.setup })
      const agent = makeAgent(options.resumeSessionId)
      const agentCtx = new Context()
      contexts.push(agentCtx)
      await options.setup?.(agentCtx)
      return { agent }
    },
  })
  ctx.provide('sessions', {
    async flush(session: unknown) { flushed.push(session) },
  })
  ctx.provide('permissionPresets', {
    set(session: unknown, name: string) { permissionSet.push({ session, name }) },
  })
  ctx.provide('agentPresets', {
    async resolve() { return { id: 'default-preset' } },
    async mount(agentCtx: Context, id: string | undefined) { mountCalls.push({ ctx: agentCtx, id }) },
  })
  ctx.provide('sessionPersistence', {
    async inspect(_id: SessionId) {
      return { meta: { agentPreset: 'recorded-preset' }, events: [] }
    },
  })
  return { ctx, created, resumed, agents, flushed, permissionSet, mountCalls }
}

describe('runScheduledTask', () => {
  it('creates a fresh agent for a new conversation, applies permission, and follows up', async () => {
    const h = harness()
    const outcome = await runScheduledTask(h.ctx, record())
    expect(outcome.sessionId).toBe(h.agents[0]?.id)
    expect(h.created).toHaveLength(1)
    expect(h.resumed).toHaveLength(0)
    expect(h.mountCalls).toHaveLength(1)
    expect(h.mountCalls[0]?.id).toBe('default-preset')
    expect(h.permissionSet).toEqual([{ session: h.agents[0]?.session, name: 'workspace-write' }])
    expect(h.agents[0]?.followed).toHaveLength(1)
    expect(h.agents[0]?.followed[0]?.source).toMatchObject({ kind: 'plugin', plugin: SCHEDULED_TASK_SOURCE })
    expect(h.agents[0]?.followed[0]?.content).toEqual([{ type: 'text', text: 'summarize' }])
    expect(h.flushed).toEqual([h.agents[0]?.session])
  })

  it('resumes the dedicated session for a task-session conversation after the first run', async () => {
    const h = harness()
    const task = record({
      conversation: { kind: 'task-session' },
      lastRunSessionId: SessionId('session-dedicated'),
    })
    const outcome = await runScheduledTask(h.ctx, task)
    expect(outcome.sessionId).toBe(SessionId('session-dedicated'))
    expect(h.created).toHaveLength(0)
    expect(h.resumed).toHaveLength(1)
    expect(h.mountCalls[0]?.id).toBe('recorded-preset')
  })

  it('resumes a named session for a session conversation', async () => {
    const h = harness()
    const task = record({ conversation: { kind: 'session', sessionId: SessionId('session-named') } })
    const outcome = await runScheduledTask(h.ctx, task)
    expect(outcome.sessionId).toBe(SessionId('session-named'))
    expect(h.created).toHaveLength(0)
    expect(h.resumed).toHaveLength(1)
  })

  it('includes the reasoning effort when present', async () => {
    const h = harness()
    await runScheduledTask(h.ctx, record({
      model: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    }))
    expect(h.created).toHaveLength(1)
  })

  it('does not mount or apply permission when the services are absent', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const created: FakeAgent[] = []
    ctx.provide('agents', {
      async create(options: { sessionId: SessionId }) {
        const agent: FakeAgent = {
          id: options.sessionId,
          session: { id: options.sessionId },
          followed: [],
          followup(message: UserMessage) { agent.followed.push(message) },
        }
        created.push(agent)
        return { agent }
      },
      async resume() { throw new Error('unexpected resume') },
    })
    ctx.provide('sessions', { async flush() {} })
    const outcome = await runScheduledTask(ctx, record())
    expect(outcome.sessionId).toBe(created[0]?.id)
  })
})
