/**
 * Durable cross-session scheduled-task service: definition CRUD over the
 * storage-domain form, plus the global scheduler loop that starts (or resumes)
 * an agent when a task comes due.
 * @module @deepseek-ai/dsh-scheduled-task
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import {
  MIN_INTERVAL_SECONDS,
  ScheduleValidationError,
  resolveCronSchedule,
} from './domain.ts'
import { runScheduledTask } from './runner.ts'
import { ScheduledTaskRuntime } from './runtime.ts'
import { scheduledTaskDomainSpec } from './spec.ts'
import type {
  ConversationMode,
  ScheduledTaskCreateRequest,
  ScheduledTaskCreateResult,
  ScheduledTaskDeleteRequest,
  ScheduledTaskDeleteResult,
  ScheduledTaskErrorCode,
  ScheduledTaskId,
  ScheduledTaskListResult,
  ScheduledTaskRecord,
  ScheduledTaskRejected,
  ScheduledTaskRunNowRequest,
  ScheduledTaskRunNowResult,
  ScheduledTaskRunValue,
  ScheduledTaskSetEnabledRequest,
  ScheduledTaskSetEnabledResult,
  ScheduledTaskSuccess,
  ScheduledTaskUpdateRequest,
  ScheduledTaskUpdateResult,
  ScheduleRule,
} from './types.ts'

export type * from './types.ts'
export {
  MIN_INTERVAL_SECONDS,
  ScheduleValidationError,
  canonicalizeTimeZone,
  nextRunAt,
  resolveCronSchedule,
} from './domain.ts'
export { earliestDue, dueTasks, ScheduledTaskRuntime, MAX_TIMER_DELAY_MS } from './runtime.ts'
export { runScheduledTask, SCHEDULED_TASK_SOURCE } from './runner.ts'
export { scheduledTaskDomainSpec, scheduledTaskRecordSchema } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    scheduledTasks: ScheduledTaskService
  }
}

/** Deployment-varying service config. */
export interface Config {
  /** Minimum accepted fixed-rate interval in seconds. */
  readonly minIntervalSeconds?: number
}

/** Frozen success branch. */
function success<T>(value: T): ScheduledTaskSuccess<T> {
  return { ok: true, value }
}

/** Frozen rejection branch with a stable public code. */
function rejected(code: ScheduledTaskErrorCode, message: string): ScheduledTaskRejected {
  return { ok: false, error: { code, message } }
}

/** Copy and freeze a record before it crosses the service boundary. */
function snapshotRecord(record: ScheduledTaskRecord): ScheduledTaskRecord {
  return Object.freeze({
    ...record,
    schedule: Object.freeze(record.schedule),
    model: Object.freeze(record.model),
    conversation: Object.freeze(record.conversation),
    ...record.lastRunError === undefined ? {} : { lastRunError: Object.freeze(record.lastRunError) },
  })
}

/** Generate a never-reused task id. */
function nextId(): ScheduledTaskId {
  return `task-${randomUUID()}` as ScheduledTaskId
}

/** Validate a non-empty display name. */
function resolveName(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new ScheduleValidationError({ code: 'invalid_name', message: 'task name must not be blank.' })
  }
  return trimmed
}

/** Validate a non-empty prompt. */
function resolvePrompt(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new ScheduleValidationError({ code: 'invalid_prompt', message: 'task prompt must not be blank.' })
  }
  return trimmed
}

/** Validate and normalize one schedule rule. */
function resolveSchedule(value: ScheduleRule, minIntervalSeconds: number): ScheduleRule {
  if (value.kind === 'cron') return resolveCronSchedule(value.expression, value.timeZone)
  if (!Number.isSafeInteger(value.everySeconds) || value.everySeconds < minIntervalSeconds) {
    throw new ScheduleValidationError({
      code: 'invalid_schedule',
      message: `interval everySeconds must be a safe integer >= ${minIntervalSeconds}.`,
    })
  }
  return { kind: 'interval', everySeconds: value.everySeconds }
}

/** The model route fields shared by the durable record and the create/update request. */
interface ModelRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Validate a model route: non-empty provider and model ids. */
function resolveModel(model: ModelRoute): ModelRoute {
  const provider = model.provider.trim()
  const id = model.model.trim()
  if (provider === '' || id === '') {
    throw new ScheduleValidationError({ code: 'invalid_model', message: 'model provider and model must not be blank.' })
  }
  return {
    provider,
    model: id,
    ...model.reasoningEffort === undefined || model.reasoningEffort.trim() === ''
      ? {}
      : { reasoningEffort: model.reasoningEffort.trim() },
  }
}

/** Deep JSON equality for plain field values; used to skip no-op update writes. */
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Validate a conversation mode; a `session` mode needs a non-empty session id. */
function resolveConversation(value: ConversationMode): ConversationMode {
  if (value.kind === 'session' && value.sessionId.trim() === '') {
    throw new ScheduleValidationError({
      code: 'invalid_conversation',
      message: 'reuse-session conversation needs a session id.',
    })
  }
  return value
}

/**
 * Durable scheduled-task service (`ctx.scheduledTasks`): CRUD plus the
 * scheduler loop that starts a run when a task comes due. Requires the
 * storage-domain form; agent presets and permission presets are optional and
 * read through the global service store.
 */
export class ScheduledTaskService extends TypertRemoteService {
  static inject = ['storageDomain', 'agents', 'sessions']

  static Config: z<Config> = z.object({
    minIntervalSeconds: z.number().default(MIN_INTERVAL_SECONDS),
  })

  private readonly minIntervalSeconds: number
  private table?: KvTable<ScheduledTaskId, ScheduledTaskRecord>
  private runtime?: ScheduledTaskRuntime
  private admissionOpen = true

  /**
   * @param ctx - host context carrying the storage-domain form and agent registry.
   * @param config - minimum fixed-rate interval.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'scheduledTasks')
    // The Config schema defaults the field, so `Math.max` only guards a
    // misconfigured smaller-than-minimum value.
    this.minIntervalSeconds = Math.max(MIN_INTERVAL_SECONDS, config.minIntervalSeconds ?? MIN_INTERVAL_SECONDS)
  }

  /** Open the domain, then start the scheduler loop. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(scheduledTaskDomainSpec)
    this.ctx.effect(() => async () => {
      this.admissionOpen = false
      await this.runtime?.dispose()
      await domain.close()
    }, 'scheduled-task.domainClose')
    this.table = domain.table('tasks')
    this.runtime = new ScheduledTaskRuntime(
      this.ctx,
      () => this.listRecords(),
      async (task) => { await this.executeRun(task) },
    )
    this.runtime.start()
  }

  /** Read every task in creation order. */
  listRecords(): readonly ScheduledTaskRecord[] {
    const table = this.requireTable()
    const records = [...table.entries()]
      .map(([, record]) => record)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    return records
  }

  /** List every task, frozen and in creation order. */
  @Remote('list')
  list(): ScheduledTaskListResult {
    return success({ items: Object.freeze([...this.listRecords().map(snapshotRecord)]) })
  }

  /** Create one task and arm the scheduler for it. */
  @Remote('create')
  async create(request: ScheduledTaskCreateRequest): Promise<ScheduledTaskCreateResult> {
    const resolved = this.resolveCreate(request)
    if (!resolved.ok) return resolved
    const record = resolved.value
    await this.requireTable().put(record.id, record)
    this.runtime?.requestDrive()
    return success(snapshotRecord(record))
  }

  /** Update mutable fields of one task. */
  @Remote('update')
  async update(request: ScheduledTaskUpdateRequest): Promise<ScheduledTaskUpdateResult> {
    const table = this.requireTable()
    const existing = table.get(request.id)
    if (existing === undefined) {
      return rejected('task_not_found', `task "${request.id}" not found`)
    }
    const changes: {
      name?: string
      prompt?: string
      schedule?: ScheduleRule
      model?: ModelRoute
      permission?: string
      conversation?: ConversationMode
    } = {}
    try {
      if (request.name !== undefined) {
        const name = resolveName(request.name)
        if (name !== existing.name) changes.name = name
      }
      if (request.prompt !== undefined) {
        const prompt = resolvePrompt(request.prompt)
        if (prompt !== existing.prompt) changes.prompt = prompt
      }
      if (request.schedule !== undefined) {
        const schedule = resolveSchedule(request.schedule, this.minIntervalSeconds)
        if (!sameJson(schedule, existing.schedule)) changes.schedule = schedule
      }
      if (request.model !== undefined) {
        const model = resolveModel(request.model)
        if (!sameJson(model, existing.model)) changes.model = model
      }
      if (request.permission !== undefined) {
        const permission = this.resolvePermission(request.permission)
        if (permission !== existing.permission) changes.permission = permission
      }
      if (request.conversation !== undefined) {
        const conversation = resolveConversation(request.conversation)
        if (!sameJson(conversation, existing.conversation)) changes.conversation = conversation
      }
    } catch (error: unknown) {
      return this.validationFailure(error)
    }
    if (Object.keys(changes).length === 0) return success(snapshotRecord(existing))
    const next: ScheduledTaskRecord = { ...existing, ...changes, updatedAt: new Date().toISOString() }
    await table.put(next.id, next)
    this.runtime?.requestDrive()
    return success(snapshotRecord(next))
  }

  /** Delete one task. */
  @Remote('delete')
  async delete(request: ScheduledTaskDeleteRequest): Promise<ScheduledTaskDeleteResult> {
    const deleted = await this.requireTable().delete(request.id)
    if (!deleted) return rejected('task_not_found', `task "${request.id}" not found`)
    this.runtime?.requestDrive()
    return success({ deleted: true })
  }

  /** Enable or disable one task. */
  @Remote('setEnabled')
  async setEnabled(request: ScheduledTaskSetEnabledRequest): Promise<ScheduledTaskSetEnabledResult> {
    const table = this.requireTable()
    const existing = table.get(request.id)
    if (existing === undefined) {
      return rejected('task_not_found', `task "${request.id}" not found`)
    }
    if (existing.enabled === request.enabled) return success(snapshotRecord(existing))
    const next: ScheduledTaskRecord = {
      ...existing,
      enabled: request.enabled,
      updatedAt: new Date().toISOString(),
    }
    await table.put(next.id, next)
    this.runtime?.requestDrive()
    return success(snapshotRecord(next))
  }

  /** Run one task immediately, regardless of its schedule. */
  @Remote('runNow')
  async runNow(request: ScheduledTaskRunNowRequest): Promise<ScheduledTaskRunNowResult> {
    const record = this.requireTable().get(request.id)
    if (record === undefined) {
      return rejected('task_not_found', `task "${request.id}" not found`)
    }
    try {
      return success(await this.executeRun(record))
    } catch (error: unknown) {
      return this.validationFailure(error)
    }
  }

  /** Validate and materialize a create request into a durable record. */
  private resolveCreate(
    request: ScheduledTaskCreateRequest,
  ): ScheduledTaskSuccess<ScheduledTaskRecord> | ScheduledTaskRejected {
    if (!this.admissionOpen) {
      return rejected('internal', 'scheduled-task service is closing')
    }
    try {
      const now = new Date().toISOString()
      const record: ScheduledTaskRecord = {
        id: nextId(),
        name: resolveName(request.name),
        prompt: resolvePrompt(request.prompt),
        schedule: resolveSchedule(request.schedule, this.minIntervalSeconds),
        model: resolveModel(request.model),
        permission: this.resolvePermission(request.permission),
        conversation: resolveConversation(request.conversation),
        enabled: request.enabled ?? true,
        createdAt: now,
        updatedAt: now,
      }
      return { ok: true, value: record }
    } catch (error: unknown) {
      return this.validationFailure(error)
    }
  }

  /** Resolve a permission preset name when the permission service is mounted. */
  private resolvePermission(name: string): string {
    const trimmed = name.trim()
    if (trimmed === '') {
      throw new ScheduleValidationError({
        code: 'invalid_permission',
        message: 'permission preset must not be blank.',
      })
    }
    const presets = this.ctx.get('permissionPresets')
    if (presets !== undefined && !presets.names.includes(trimmed)) {
      throw new ScheduleValidationError({
        code: 'invalid_permission',
        message: `unknown permission preset "${trimmed}" (available: ${presets.names.join(', ')})`,
      })
    }
    return trimmed
  }

  /** Run one task and record the outcome durably. */
  private async executeRun(record: ScheduledTaskRecord): Promise<ScheduledTaskRunValue> {
    const now = new Date().toISOString()
    try {
      const outcome = await runScheduledTask(this.ctx, record)
      await this.requireTable().update(record.id, (current) => {
        const { lastRunError: _previousError, ...rest } = current
        return {
          ...rest,
          updatedAt: now,
          lastRunAt: now,
          lastRunSessionId: outcome.sessionId,
        }
      })
      return { sessionId: outcome.sessionId }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        await this.requireTable().update(record.id, current => ({
          ...current,
          updatedAt: now,
          lastRunAt: now,
          lastRunError: { code: 'internal', message },
        }))
      } catch (bookkeepingError: unknown) {
        this.ctx.logger.warn(
          `scheduled-task: could not record run failure for "${record.id}": ${String(bookkeepingError)}`,
        )
      }
      throw error
    }
  }

  /** Convert a caught validation failure to a stable public rejection. */
  private validationFailure(error: unknown): ScheduledTaskRejected {
    if (error instanceof ScheduleValidationError) {
      return rejected(error.code, error.message)
    }
    return rejected('internal', error instanceof Error ? error.message : String(error))
  }

  /** The domain table, once the service is initialized. */
  private requireTable(): KvTable<ScheduledTaskId, ScheduledTaskRecord> {
    if (this.table === undefined) throw new Error('scheduled-task service is not started yet')
    return this.table
  }
}

export default ScheduledTaskService
