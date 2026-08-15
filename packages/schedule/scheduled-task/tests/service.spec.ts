import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import ScheduledTaskService from '../src/index.ts'
import type { ScheduledTaskCreateRequest, ScheduledTaskRecord } from '../src/types.ts'

interface Harness {
  ctx: Context
  root: string
  created: string[]
  resumed: string[]
  followed: UserMessage[]
  permissionSet: string[]
  createThrows: unknown
  resumeThrows: unknown
  deferredCreate: boolean
  disposed: boolean
  rejectDeferredCreate?: (reason: unknown) => void
  dispose(): Promise<void>
}

const contexts: Harness[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(value => value.dispose()))
})

async function harness(options: {
  createThrows?: unknown
  resumeThrows?: unknown
  deferredCreate?: boolean
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-scheduled-task-test-'))
  const ctx = new Context()
  const created: string[] = []
  const resumed: string[] = []
  const followed: UserMessage[] = []
  const permissionSet: string[] = []
  const value: Harness = {
    ctx, root, created, resumed, followed, permissionSet,
    createThrows: options.createThrows ?? false,
    resumeThrows: options.resumeThrows ?? false,
    deferredCreate: options.deferredCreate ?? false,
    disposed: false,
    async dispose() {
      if (value.disposed) return
      value.disposed = true
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }

  const makeAgent = (id: SessionId) => ({
    id,
    session: { id },
    followup(message: UserMessage) { followed.push(message) },
  })

  ctx.provide('agents', {
    withoutInitiator<T>(operation: () => T): T { return operation() },
    create(opts: { sessionId: SessionId; setup?: (c: Context) => unknown }) {
      if (value.deferredCreate) {
        return new Promise<{ agent: unknown }>((_resolve, reject) => {
          value.rejectDeferredCreate = reject
        })
      }
      if (value.createThrows !== false) throw value.createThrows
      created.push(opts.sessionId)
      const agentCtx = new Context()
      return Promise.resolve(opts.setup?.(agentCtx)).then(async () => {
        await agentCtx.fiber.dispose()
        return { agent: makeAgent(opts.sessionId) }
      })
    },
    async resume(opts: { resumeSessionId: SessionId; setup?: (c: Context) => unknown }) {
      if (value.resumeThrows !== false) throw value.resumeThrows
      resumed.push(opts.resumeSessionId)
      const agentCtx = new Context()
      await opts.setup?.(agentCtx)
      await agentCtx.fiber.dispose()
      return { agent: makeAgent(opts.resumeSessionId) }
    },
  })
  ctx.provide('sessions', { async flush() {} })
  ctx.provide('permissionPresets', {
    names: ['workspace-write', 'danger-full-access'],
    set(_session: unknown, name: string) { permissionSet.push(name) },
  })

  try {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(ScheduledTaskService)
  } catch (error) {
    await value.dispose()
    throw error
  }
  contexts.push(value)
  return value
}

function createRequest(overrides: Partial<ScheduledTaskCreateRequest> = {}): ScheduledTaskCreateRequest {
  return {
    name: 'daily report',
    prompt: 'summarize the logs',
    schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' },
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    permission: 'workspace-write',
    conversation: { kind: 'new' },
    ...overrides,
  }
}

describe('ScheduledTaskService public contract', () => {
  it('publishes the exact Gateway namespace and Remote method names', async () => {
    const { ctx } = await harness()
    expect(ctx.scheduledTasks.typertRemote.namespace).toBe('scheduledTasks')
    expect(remoteMethods(ctx.scheduledTasks)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'create', invocation: { kind: 'direct' } },
      { method: 'update', invocation: { kind: 'direct' } },
      { method: 'delete', invocation: { kind: 'direct' } },
      { method: 'setEnabled', invocation: { kind: 'direct' } },
      { method: 'runNow', invocation: { kind: 'direct' } },
    ])
  })

  it('lists tasks in creation order', async () => {
    const { ctx } = await harness()
    await ctx.scheduledTasks.create(createRequest({ name: 'first' }))
    await ctx.scheduledTasks.create(createRequest({ name: 'second', schedule: { kind: 'interval', everySeconds: 60 } }))
    const list = ctx.scheduledTasks.list()
    if (!list.ok) throw new Error(list.error.message)
    expect(list.value.items.map(item => item.name)).toEqual(['first', 'second'])
  })

  it('rejects invalid create input for every field', async () => {
    const { ctx } = await harness()
    await expect(ctx.scheduledTasks.create(createRequest({ name: '   ' }))).resolves.toEqual({
      ok: false, error: { code: 'invalid_name', message: 'task name must not be blank.' },
    })
    await expect(ctx.scheduledTasks.create(createRequest({ prompt: '  ' }))).resolves.toEqual({
      ok: false, error: { code: 'invalid_prompt', message: 'task prompt must not be blank.' },
    })
    await expect(ctx.scheduledTasks.create(createRequest({
      schedule: { kind: 'interval', everySeconds: 10 },
    }))).resolves.toEqual({
      ok: false, error: { code: 'invalid_schedule', message: 'interval everySeconds must be a safe integer >= 60.' },
    })
    await expect(ctx.scheduledTasks.create(createRequest({
      schedule: { kind: 'cron', expression: 'not a cron', timeZone: 'UTC' },
    }))).resolves.toMatchObject({ ok: false, error: { code: 'invalid_schedule' } })
    await expect(ctx.scheduledTasks.create(createRequest({
      schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'Not/AZone' },
    }))).resolves.toMatchObject({ ok: false, error: { code: 'invalid_time_zone' } })
    await expect(ctx.scheduledTasks.create(createRequest({ model: { provider: ' ', model: 'm' } }))).resolves.toEqual({
      ok: false, error: { code: 'invalid_model', message: 'model provider and model must not be blank.' },
    })
    await expect(ctx.scheduledTasks.create(createRequest({ permission: 'unknown-preset' }))).resolves.toEqual({
      ok: false, error: { code: 'invalid_permission', message: 'unknown permission preset "unknown-preset" (available: workspace-write, danger-full-access)' },
    })
    await expect(ctx.scheduledTasks.create(createRequest({ conversation: { kind: 'session', sessionId: '  ' as never } }))).resolves.toEqual({
      ok: false, error: { code: 'invalid_conversation', message: 'reuse-session conversation needs a session id.' },
    })
    await expect(ctx.scheduledTasks.create(createRequest({ cwd: 'relative/path' }))).resolves.toEqual({
      ok: false, error: { code: 'invalid_cwd', message: 'working directory must be an absolute path.' },
    })
  })

  it('stores an absolute cwd and omits a blank one', async () => {
    const { ctx } = await harness()
    const withCwd = await ctx.scheduledTasks.create(createRequest({ cwd: '  /srv/reports  ' }))
    if (!withCwd.ok) throw new Error(withCwd.error.message)
    expect(withCwd.value.cwd).toBe('/srv/reports')
    const blank = await ctx.scheduledTasks.create(createRequest({ cwd: '   ' }))
    if (!blank.ok) throw new Error(blank.error.message)
    expect(blank.value.cwd).toBeUndefined()
  })

  it('creates with default enabled and trims model reasoning effort', async () => {
    const { ctx } = await harness()
    const create = await ctx.scheduledTasks.create(createRequest({
      model: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: '  high  ' },
    }))
    if (!create.ok) throw new Error(create.error.message)
    expect(create.value.enabled).toBe(true)
    expect(create.value.model.reasoningEffort).toBe('high')
    expect(create.value.model.reasoningEffort).toBe('high')
  })

  it('omits a blank reasoning effort from the model', async () => {
    const { ctx } = await harness()
    const create = await ctx.scheduledTasks.create(createRequest({
      model: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: '   ' },
    }))
    if (!create.ok) throw new Error(create.error.message)
    expect(create.value.model.reasoningEffort).toBeUndefined()
  })
})

describe('ScheduledTaskService update', () => {
  async function make(ctx: Context): Promise<ScheduledTaskRecord> {
    const create = await ctx.scheduledTasks.create(createRequest())
    if (!create.ok) throw new Error(create.error.message)
    return create.value
  }

  it('returns task_not_found for an unknown id', async () => {
    const { ctx } = await harness()
    await expect(ctx.scheduledTasks.update({ id: 'missing' as never, name: 'x' })).resolves.toEqual({
      ok: false, error: { code: 'task_not_found', message: 'task "missing" not found' },
    })
  })

  it('updates every mutable field', async () => {
    const { ctx } = await harness()
    const task = await make(ctx)
    const update = await ctx.scheduledTasks.update({
      id: task.id,
      name: 'renamed',
      prompt: 'new prompt',
      schedule: { kind: 'interval', everySeconds: 120 },
      model: { provider: 'p2', model: 'm2' },
      permission: 'danger-full-access',
      conversation: { kind: 'task-session' },
      cwd: '/srv/reports',
    })
    if (!update.ok) throw new Error(update.error.message)
    expect(update.value).toMatchObject({
      name: 'renamed',
      prompt: 'new prompt',
      schedule: { kind: 'interval', everySeconds: 120 },
      model: { provider: 'p2', model: 'm2' },
      permission: 'danger-full-access',
      conversation: { kind: 'task-session' },
      cwd: '/srv/reports',
    })
  })

  it('returns the existing record unchanged when no field differs', async () => {
    const { ctx } = await harness()
    const task = await make(ctx)
    const update = await ctx.scheduledTasks.update({ id: task.id, name: task.name })
    if (!update.ok) throw new Error(update.error.message)
    expect(update.value.updatedAt).toBe(task.updatedAt)
  })

  it('rejects invalid update input per field', async () => {
    const { ctx } = await harness()
    const task = await make(ctx)
    await expect(ctx.scheduledTasks.update({ id: task.id, name: '  ' })).resolves.toEqual({
      ok: false, error: { code: 'invalid_name', message: 'task name must not be blank.' },
    })
    await expect(ctx.scheduledTasks.update({ id: task.id, prompt: '  ' })).resolves.toEqual({
      ok: false, error: { code: 'invalid_prompt', message: 'task prompt must not be blank.' },
    })
    await expect(ctx.scheduledTasks.update({ id: task.id, permission: '  ' })).resolves.toEqual({
      ok: false, error: { code: 'invalid_permission', message: 'permission preset must not be blank.' },
    })
    await expect(ctx.scheduledTasks.update({ id: task.id, permission: 'nope' })).resolves.toMatchObject({
      ok: false, error: { code: 'invalid_permission' },
    })
    await expect(ctx.scheduledTasks.update({ id: task.id, schedule: { kind: 'interval', everySeconds: 1 } })).resolves.toEqual({
      ok: false, error: { code: 'invalid_schedule', message: 'interval everySeconds must be a safe integer >= 60.' },
    })
    await expect(ctx.scheduledTasks.update({ id: task.id, model: { provider: '', model: 'm' } })).resolves.toEqual({
      ok: false, error: { code: 'invalid_model', message: 'model provider and model must not be blank.' },
    })
    await expect(ctx.scheduledTasks.update({ id: task.id, conversation: { kind: 'session', sessionId: '' as never } })).resolves.toEqual({
      ok: false, error: { code: 'invalid_conversation', message: 'reuse-session conversation needs a session id.' },
    })
    await expect(ctx.scheduledTasks.update({ id: task.id, cwd: 'relative' })).resolves.toEqual({
      ok: false, error: { code: 'invalid_cwd', message: 'working directory must be an absolute path.' },
    })
  })

  it('clears the cwd when updated with a blank value', async () => {
    const { ctx } = await harness()
    const create = await ctx.scheduledTasks.create(createRequest({ cwd: '/srv/reports' }))
    if (!create.ok) throw new Error(create.error.message)
    const update = await ctx.scheduledTasks.update({ id: create.value.id, cwd: '   ' })
    if (!update.ok) throw new Error(update.error.message)
    expect(update.value.cwd).toBeUndefined()
  })

  it('skips no-op writes for identical schedule, model, prompt, and conversation', async () => {
    const { ctx } = await harness()
    const task = await make(ctx)
    const update = await ctx.scheduledTasks.update({
      id: task.id,
      prompt: task.prompt,
      schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' },
      model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      conversation: { kind: 'new' },
    })
    if (!update.ok) throw new Error(update.error.message)
    expect(update.value.updatedAt).toBe(task.updatedAt)
  })
})

describe('ScheduledTaskService delete and setEnabled', () => {
  it('returns task_not_found for a missing delete', async () => {
    const { ctx } = await harness()
    await expect(ctx.scheduledTasks.delete({ id: 'missing' as never })).resolves.toEqual({
      ok: false, error: { code: 'task_not_found', message: 'task "missing" not found' },
    })
  })

  it('deletes an existing task', async () => {
    const { ctx } = await harness()
    const create = await ctx.scheduledTasks.create(createRequest())
    if (!create.ok) throw new Error(create.error.message)
    const removed = await ctx.scheduledTasks.delete({ id: create.value.id })
    expect(removed).toEqual({ ok: true, value: { deleted: true } })
  })

  it('returns task_not_found for a missing setEnabled', async () => {
    const { ctx } = await harness()
    await expect(ctx.scheduledTasks.setEnabled({ id: 'missing' as never, enabled: true })).resolves.toEqual({
      ok: false, error: { code: 'task_not_found', message: 'task "missing" not found' },
    })
  })

  it('returns unchanged when enable state already matches', async () => {
    const { ctx } = await harness()
    const create = await ctx.scheduledTasks.create(createRequest())
    if (!create.ok) throw new Error(create.error.message)
    const disabled = await ctx.scheduledTasks.setEnabled({ id: create.value.id, enabled: false })
    if (!disabled.ok) throw new Error(disabled.error.message)
    expect(disabled.value.enabled).toBe(false)
    const again = await ctx.scheduledTasks.setEnabled({ id: create.value.id, enabled: false })
    if (!again.ok) throw new Error(again.error.message)
    expect(again.value.updatedAt).toBe(disabled.value.updatedAt)
  })
})

describe('ScheduledTaskService runNow and executeRun', () => {
  it('returns task_not_found for a missing runNow', async () => {
    const { ctx } = await harness()
    await expect(ctx.scheduledTasks.runNow({ id: 'missing' as never })).resolves.toEqual({
      ok: false, error: { code: 'task_not_found', message: 'task "missing" not found' },
    })
  })

  it('runs a new-conversation task and records lastRunAt', async () => {
    const h = await harness()
    const create = await h.ctx.scheduledTasks.create(createRequest())
    if (!create.ok) throw new Error(create.error.message)
    const run = await h.ctx.scheduledTasks.runNow({ id: create.value.id })
    if (!run.ok) throw new Error(run.error.message)
    expect(h.created).toHaveLength(1)
    expect(h.followed).toHaveLength(1)
    expect(h.permissionSet).toEqual(['workspace-write'])
    const list = h.ctx.scheduledTasks.list()
    if (!list.ok) throw new Error(list.error.message)
    expect(list.value.items[0]?.lastRunAt).toBeDefined()
    expect(list.value.items[0]?.lastRunError).toBeUndefined()
    expect(list.value.items[0]?.lastRunSessionId).toBe(run.value.sessionId)
  })

  it('runs a task-session conversation, creating on the first run and resuming after', async () => {
    const h = await harness()
    const create = await h.ctx.scheduledTasks.create(createRequest({ conversation: { kind: 'task-session' } }))
    if (!create.ok) throw new Error(create.error.message)
    const first = await h.ctx.scheduledTasks.runNow({ id: create.value.id })
    if (!first.ok) throw new Error(first.error.message)
    expect(h.created).toHaveLength(1)
    const second = await h.ctx.scheduledTasks.runNow({ id: create.value.id })
    if (!second.ok) throw new Error(second.error.message)
    expect(h.resumed).toHaveLength(1)
    expect(h.resumed[0]).toBe(first.value.sessionId)
  })

  it('records lastRunError when the run fails to start', async () => {
    const h = await harness({ createThrows: new Error('create failed') })
    const create = await h.ctx.scheduledTasks.create(createRequest())
    if (!create.ok) throw new Error(create.error.message)
    const run = await h.ctx.scheduledTasks.runNow({ id: create.value.id })
    expect(run).toMatchObject({ ok: false, error: { code: 'internal' } })
    const list = h.ctx.scheduledTasks.list()
    if (!list.ok) throw new Error(list.error.message)
    expect(list.value.items[0]?.lastRunError).toEqual({ code: 'internal', message: 'create failed' })
    expect(list.value.items[0]?.lastRunAt).toBeDefined()
  })

  it('records lastRunError when resume fails', async () => {
    const h = await harness({ resumeThrows: new Error('resume failed') })
    const create = await h.ctx.scheduledTasks.create(createRequest({
      conversation: { kind: 'session', sessionId: SessionId('session-named') },
    }))
    if (!create.ok) throw new Error(create.error.message)
    const run = await h.ctx.scheduledTasks.runNow({ id: create.value.id })
    expect(run).toMatchObject({ ok: false, error: { code: 'internal', message: 'resume failed' } })
    const list = h.ctx.scheduledTasks.list()
    if (!list.ok) throw new Error(list.error.message)
    expect(list.value.items[0]?.lastRunError?.message).toBe('resume failed')
  })

  it('records a stringified non-Error run failure', async () => {
    const h = await harness({ createThrows: 'kaboom' })
    const create = await h.ctx.scheduledTasks.create(createRequest())
    if (!create.ok) throw new Error(create.error.message)
    const run = await h.ctx.scheduledTasks.runNow({ id: create.value.id })
    expect(run).toEqual({ ok: false, error: { code: 'internal', message: 'kaboom' } })
  })

  it('warns without throwing when recording the run failure itself fails', async () => {
    const h = await harness({ deferredCreate: true })
    const create = await h.ctx.scheduledTasks.create(createRequest())
    if (!create.ok) throw new Error(create.error.message)
    const warnings: string[] = []
    h.ctx.logger.warn = (message: string) => { warnings.push(message) }
    // Start the run so it suspends inside the deferred agent creation, then
    // delete the record so the failure bookkeeping update finds it missing.
    const runPromise = h.ctx.scheduledTasks.runNow({ id: create.value.id })
    const removed = await h.ctx.scheduledTasks.delete({ id: create.value.id })
    expect(removed).toEqual({ ok: true, value: { deleted: true } })
    h.rejectDeferredCreate?.(new Error('agent boom'))
    const run = await runPromise
    expect(run).toEqual({ ok: false, error: { code: 'internal', message: 'agent boom' } })
    expect(warnings.some(message => message.includes('could not record run failure'))).toBe(true)
  })

  it('fires a due interval task through the scheduler loop', async () => {
    vi.useFakeTimers()
    const h = await harness()
    const create = await h.ctx.scheduledTasks.create(createRequest({
      schedule: { kind: 'interval', everySeconds: 60 },
    }))
    if (!create.ok) throw new Error(create.error.message)
    const first = await h.ctx.scheduledTasks.runNow({ id: create.value.id })
    if (!first.ok) throw new Error(first.error.message)
    expect(h.created).toHaveLength(1)
    // Re-arm the scheduler after the run recorded lastRunAt, then advance past
    // the interval so the loop itself performs the next run.
    await h.ctx.scheduledTasks.setEnabled({ id: create.value.id, enabled: false })
    await h.ctx.scheduledTasks.setEnabled({ id: create.value.id, enabled: true })
    await vi.advanceTimersByTimeAsync(61_000)
    expect(h.created).toHaveLength(2)
  })
})

describe('ScheduledTaskService lifecycle guards', () => {
  it('rejects create after the service is disposed', async () => {
    const h = await harness()
    const service = h.ctx.scheduledTasks
    await h.dispose()
    await expect(service.create(createRequest())).resolves.toEqual({
      ok: false, error: { code: 'internal', message: 'scheduled-task service is closing' },
    })
  })

  it('throws when a method is called before initialization', () => {
    const ctx = new Context()
    const service = new ScheduledTaskService(ctx, {})
    expect(() => service.list()).toThrow('scheduled-task service is not started yet')
  })
})
