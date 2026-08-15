/**
 * Disposable global scheduler loop for scheduled tasks.
 * @module @deepseek-ai/dsh-scheduled-task
 */

import type { Context } from '@deepseek-ai/cordis'
import { nextRunAt } from './domain.ts'
import type { ScheduledTaskRecord } from './types.ts'

/** Largest delay that Node timers represent without clamping. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** The instant one task next runs after, in epoch ms; a never-run task anchors on `now`. */
function nextRunAfter(task: ScheduledTaskRecord, now: number): number | undefined {
  const from = task.lastRunAt === undefined ? now : Date.parse(task.lastRunAt)
  return nextRunAt(task.schedule, from)
}

/** The next due instant among enabled tasks, or `undefined` when none fires. */
export function earliestDue(tasks: readonly ScheduledTaskRecord[], now: number): number | undefined {
  let earliest: number | undefined
  for (const task of tasks) {
    if (!task.enabled) continue
    const candidate = nextRunAfter(task, now)
    if (candidate === undefined) continue
    if (candidate <= now) return candidate
    if (earliest === undefined || candidate < earliest) earliest = candidate
  }
  return earliest
}

/** The enabled tasks whose next run is at or before `now`. */
export function dueTasks(tasks: readonly ScheduledTaskRecord[], now: number): ScheduledTaskRecord[] {
  const due: ScheduledTaskRecord[] = []
  for (const task of tasks) {
    if (!task.enabled) continue
    const candidate = nextRunAfter(task, now)
    if (candidate !== undefined && candidate <= now) due.push(task)
  }
  return due
}

/** Render an unknown value for process-local diagnostics only. */
function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * One process-local scheduler over the durable task table. It reads the
 * current task set from the owning service before every wake, arms a bounded
 * timer for the earliest due instant, and hands each due task to the service's
 * run path one at a time.
 */
export class ScheduledTaskRuntime {
  private readonly stop = Promise.withResolvers<void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private run: Promise<void> | undefined
  private requested = false
  private stopping = false
  private faulted = false
  private disposal: Promise<void> | undefined

  /**
   * Construct an inactive scheduler; {@link start} begins the first preflight.
   * @param ctx - host context carrying agents and the logger.
   * @param listTasks - read the current enabled task set.
   * @param runTask - run one due task and record its outcome.
   */
  constructor(
    private readonly ctx: Context,
    private readonly listTasks: () => readonly ScheduledTaskRecord[],
    private readonly runTask: (task: ScheduledTaskRecord) => Promise<void>,
  ) {}

  /** Begin the initial derivation and timer arm. */
  start(): void {
    this.requestDrive()
  }

  /** Whether this scheduler may start or continue work. */
  private isRunnable(): boolean {
    return !this.stopping && !this.faulted
  }

  /** Recompute after a committed task mutation. */
  requestDrive(): void {
    if (!this.isRunnable()) return
    this.clearTimer()
    this.requested = true
    if (this.run !== undefined) return
    let run: Promise<void>
    try {
      run = this.ctx.agents.withoutInitiator(() => this.runRequested())
    } catch (error: unknown) {
      this.ctx.logger.warn(`scheduled-task: could not start scheduler: ${renderThrown(error)}`)
      return
    }
    this.run = run
    void run.then(
      () => { this.retire(run) },
      (error: unknown) => {
        this.ctx.logger.warn(`scheduled-task: scheduler failed: ${renderThrown(error)}`)
        this.faulted = true
        this.retire(run)
      },
    )
  }

  /** Stop future work, cancel the timer, and await outstanding runs. */
  dispose(): Promise<void> {
    return (this.disposal ??= (async () => {
      this.stopping = true
      this.requested = false
      this.clearTimer()
      this.stop.resolve()
      const pending = [this.run].filter((value): value is Promise<void> => value !== undefined)
      await Promise.allSettled(pending)
    })())
  }

  /** Drain coalesced triggers serially. */
  private async runRequested(): Promise<void> {
    while (this.requested && this.isRunnable()) {
      this.requested = false
      await this.driveOnce()
    }
  }

  /** Retire one exact run and honor a trigger that landed during its final microtask. */
  private retire(run: Promise<void>): void {
    /* v8 ignore next -- only the exact stored run installs this callback. */
    if (this.run !== run) return
    this.run = undefined
    /* v8 ignore next -- covers a trigger in the promise-settlement microtask gap. */
    if (this.requested && this.isRunnable()) this.requestDrive()
  }

  /** Cancel the currently armed timer, if any. */
  private clearTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Arm one bounded timer segment; every wake rechecks the wall clock. */
  private arm(target: number, now: number): void {
    const delay = Math.min(Math.max(target - now, 0), MAX_TIMER_DELAY_MS)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.requestDrive()
    }, delay)
  }

  /** Compute the next wake from the current task set and wall clock. */
  private async driveOnce(): Promise<void> {
    this.clearTimer()
    /* v8 ignore next -- driveOnce only starts from an isRunnable preflight with no await in between. */
    if (!this.isRunnable()) return
    const tasks = this.listTasks()
    const now = Date.now()
    const due = dueTasks(tasks, now)
    for (const task of due) {
      if (!this.isRunnable()) return
      try {
        await this.runTask(task)
      } catch (error: unknown) {
        this.ctx.logger.warn(`scheduled-task: run of "${task.id}" failed: ${renderThrown(error)}`)
      }
    }
    if (!this.isRunnable()) return
    const next = earliestDue(this.listTasks(), Date.now())
    if (next !== undefined) this.arm(next, Date.now())
  }
}
