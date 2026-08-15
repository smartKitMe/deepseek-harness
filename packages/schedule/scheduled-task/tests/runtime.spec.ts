import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MAX_TIMER_DELAY_MS, ScheduledTaskRuntime, earliestDue, dueTasks } from '../src/runtime.ts'
import type { ScheduledTaskRecord } from '../src/types.ts'

const contexts: Context[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function task(id: string, everySeconds: number, enabled = true, lastRunAt?: string): ScheduledTaskRecord {
  return {
    id: id as ScheduledTaskRecord['id'],
    name: id,
    prompt: 'run',
    schedule: { kind: 'interval', everySeconds },
    model: { provider: 'p', model: 'm' },
    permission: 'workspace-write',
    conversation: { kind: 'new' },
    enabled,
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    ...lastRunAt === undefined ? {} : { lastRunAt },
  }
}

const NOW = Date.parse('2026-08-05T12:00:00.000Z')

describe('dueTasks', () => {
  it('returns nothing when no task is due', () => {
    expect(dueTasks([task('a', 3600)], NOW)).toEqual([])
  })

  it('returns a task whose interval elapsed', () => {
    const t = task('a', 3600, true, new Date(NOW - 3600_000 - 1000).toISOString())
    expect(dueTasks([t], NOW)).toEqual([t])
  })

  it('skips disabled tasks', () => {
    const t = task('a', 3600, false, new Date(NOW - 3600_000 - 1000).toISOString())
    expect(dueTasks([t], NOW)).toEqual([])
  })

  it('never fires a never-run interval task immediately', () => {
    expect(dueTasks([task('a', 3600)], NOW)).toEqual([])
  })

  it('returns a never-run cron task whose next match is already past', () => {
    // A cron whose next match after `now` lies in the past is immediately due.
    const pastCron = task('c', 0, true)
    const cronTask: ScheduledTaskRecord = {
      ...pastCron,
      schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' },
      lastRunAt: '2026-08-04T00:00:00.000Z',
    }
    expect(dueTasks([cronTask], NOW)).toEqual([cronTask])
  })
})

describe('earliestDue', () => {
  it('returns undefined for an empty set', () => {
    expect(earliestDue([], NOW)).toBeUndefined()
  })

  it('returns the earliest future interval across tasks', () => {
    const a = task('a', 3600, true, new Date(NOW).toISOString())
    const b = task('b', 7200, true, new Date(NOW).toISOString())
    expect(earliestDue([a, b], NOW)).toBe(NOW + 3600 * 1000)
  })

  it('returns an already-due instant', () => {
    const overdue = task('a', 3600, true, new Date(NOW - 3600_000 - 1000).toISOString())
    expect(earliestDue([overdue], NOW)).toBe(NOW - 3600_000 - 1000 + 3600 * 1000)
  })

  it('ignores disabled tasks when computing the earliest', () => {
    const disabled = task('a', 60, false)
    const enabled = task('b', 3600, true, new Date(NOW).toISOString())
    expect(earliestDue([disabled, enabled], NOW)).toBe(NOW + 3600 * 1000)
  })

  it('skips a cron task with no future match', () => {
    const never: ScheduledTaskRecord = {
      ...task('n', 0, true),
      schedule: { kind: 'cron', expression: '0 0 0 1 1 * 2020', timeZone: 'UTC' },
      lastRunAt: '2026-08-05T00:00:00.000Z',
    }
    expect(earliestDue([never], NOW)).toBeUndefined()
  })
})

describe('ScheduledTaskRuntime', () => {
  function harness() {
    const ctx = new Context()
    contexts.push(ctx)
    let withoutInitiatorError: unknown
    const runs: string[] = []
    let listTasks: () => readonly ScheduledTaskRecord[] = () => []
    let runTask = async (_t: ScheduledTaskRecord) => {}
    const agentless = {
      withoutInitiator<T>(operation: () => T): T {
        if (withoutInitiatorError !== undefined) throw withoutInitiatorError
        return operation()
      },
    }
    ctx.provide('agents', agentless)
    const warnings: string[] = []
    ctx.logger.warn = (message: string) => { warnings.push(message) }
    return {
      ctx, runs, warnings,
      setList(fn: () => readonly ScheduledTaskRecord[]) { listTasks = fn },
      setRun(fn: (t: ScheduledTaskRecord) => Promise<void>) { runTask = fn },
      setWithoutInitiatorError(error: unknown) { withoutInitiatorError = error },
      runtime: () => new ScheduledTaskRuntime(ctx, () => listTasks(), t => runTask(t)),
    }
  }

  it('arms a timer for the earliest future due and fires it', async () => {
    vi.useFakeTimers()
    const start = Date.now()
    const h = harness()
    const fired: string[] = []
    let list = [task('a', 3600, true, new Date(start).toISOString())]
    h.setList(() => list)
    h.setRun(async (t) => { fired.push(t.id); list = [] })
    const runtime = h.runtime()
    runtime.start()
    await vi.advanceTimersByTimeAsync(3600 * 1000 + 10)
    expect(fired).toEqual(['a'])
    await runtime.dispose()
  })

  it('runs an already-due task immediately', async () => {
    vi.useFakeTimers()
    const h = harness()
    const fired: string[] = []
    let list = [task('a', 3600, true, new Date(Date.now() - 3600_000 - 1000).toISOString())]
    h.setList(() => list)
    h.setRun(async (t) => { fired.push(t.id); list = [] })
    const runtime = h.runtime()
    runtime.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fired).toEqual(['a'])
    await runtime.dispose()
  })

  it('logs a failed run', async () => {
    vi.useFakeTimers()
    const h = harness()
    let list = [task('a', 3600, true, new Date(Date.now() - 3600_000 - 1000).toISOString())]
    h.setList(() => list)
    h.setRun(async () => { list = []; throw 'boom' })
    const runtime = h.runtime()
    runtime.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.warnings.some(message => message.includes('boom'))).toBe(true)
    await runtime.dispose()
  })

  it('logs a start failure when withoutInitiator throws', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.setWithoutInitiatorError(new Error('no initiator'))
    h.setList(() => [])
    const runtime = h.runtime()
    runtime.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.warnings.some(message => message.includes('no initiator'))).toBe(true)
    await runtime.dispose()
  })

  it('does nothing after disposal', async () => {
    vi.useFakeTimers()
    const h = harness()
    const fired: string[] = []
    h.setList(() => [task('a', 60, true, new Date(Date.now() - 1000).toISOString())])
    h.setRun(async (t) => { fired.push(t.id) })
    const runtime = h.runtime()
    await runtime.dispose()
    runtime.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fired).toEqual([])
  })

  it('ignores a redundant drive while a run is in flight', async () => {
    vi.useFakeTimers()
    const h = harness()
    const fired: string[] = []
    let release!: () => void
    let list = [task('a', 3600, true, new Date(Date.now() - 3600_000 - 1000).toISOString())]
    h.setList(() => list)
    h.setRun(async (t) => { fired.push(t.id); list = []; await new Promise<void>((resolve) => { release = resolve }) })
    const runtime = h.runtime()
    runtime.start()
    await vi.advanceTimersByTimeAsync(0)
    ;(runtime as unknown as { requestDrive(): void }).requestDrive()
    expect(fired).toEqual(['a'])
    release()
    await vi.advanceTimersByTimeAsync(0)
    await runtime.dispose()
  })

  it('faults when reading the task list throws', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.setList(() => { throw new Error('read failed') })
    const runtime = h.runtime()
    runtime.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.warnings.some(message => message.includes('read failed'))).toBe(true)
    await runtime.dispose()
  })

  it('stops between due tasks after disposal', async () => {
    vi.useFakeTimers()
    const h = harness()
    const fired: string[] = []
    let release!: () => void
    let list = [
      task('a', 3600, true, new Date(Date.now() - 3600_000 - 1000).toISOString()),
      task('b', 3600, true, new Date(Date.now() - 3600_000 - 1000).toISOString()),
    ]
    h.setList(() => list)
    h.setRun(async (t) => { fired.push(t.id); list = []; await new Promise<void>((resolve) => { release = resolve }) })
    const runtime = h.runtime()
    runtime.start()
    await vi.advanceTimersByTimeAsync(0)
    const disposal = runtime.dispose()
    release()
    await disposal
    expect(fired).toEqual(['a'])
  })

  it('stops before re-arming when disposal lands during the final run', async () => {
    vi.useFakeTimers()
    const h = harness()
    const fired: string[] = []
    let release!: () => void
    let list = [task('a', 3600, true, new Date(Date.now() - 3600_000 - 1000).toISOString())]
    h.setList(() => list)
    h.setRun(async (t) => { fired.push(t.id); list = []; await new Promise<void>((resolve) => { release = resolve }) })
    const runtime = h.runtime()
    runtime.start()
    await vi.advanceTimersByTimeAsync(0)
    const disposal = runtime.dispose()
    release()
    await disposal
    expect(fired).toEqual(['a'])
  })

  it('clears an armed timer on disposal', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.setList(() => [task('a', 3600, true, new Date(Date.now()).toISOString())])
    const runtime = h.runtime()
    runtime.start()
    await vi.advanceTimersByTimeAsync(0)
    await runtime.dispose()
  })
})

describe('MAX_TIMER_DELAY_MS', () => {
  it('is the Node timer ceiling', () => {
    expect(MAX_TIMER_DELAY_MS).toBe(2_147_483_647)
  })
})
