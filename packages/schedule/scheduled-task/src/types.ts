/**
 * Pure types of the scheduled-task domain: the durable task record, its
 * schedule/conversation vocabulary, and the Remote request/result types.
 * This module contains types only so generated Remote clients can consume it
 * without importing Host runtime code.
 * @module @deepseek-ai/dsh-scheduled-task/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Identifies one scheduled task across its durable revisions. */
export type ScheduledTaskId = Branded<'ScheduledTaskId'>

/** Cron-based recurrence: a standard five/six-field expression plus an IANA zone. */
export interface CronSchedule {
  readonly kind: 'cron'
  /** Cron expression (minute-first), e.g. `0 9 * * *`. */
  readonly expression: string
  /** `UTC` or an IANA Area/Location zone the expression is evaluated in. */
  readonly timeZone: string
}

/** Fixed-rate recurrence: run every `everySeconds` seconds from the last run. */
export interface IntervalSchedule {
  readonly kind: 'interval'
  /** Positive safe-integer seconds between runs; never below the service minimum. */
  readonly everySeconds: number
}

/** The two supported recurrence rules. */
export type ScheduleRule = CronSchedule | IntervalSchedule

/** The model route a task's runs use. */
export interface ScheduledTaskModel {
  /** Registered provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
  /** Adapter-owned reasoning effort; absence preserves provider/default behavior. */
  readonly reasoningEffort?: string
}

/** Start a fresh session on every run. */
export interface NewConversation {
  readonly kind: 'new'
}

/** Reuse a session dedicated to this task, created on the first run. */
export interface TaskSessionConversation {
  readonly kind: 'task-session'
}

/** Reuse one specific existing session on every run. */
export interface ReuseSessionConversation {
  readonly kind: 'session'
  /** Persisted session to resume. */
  readonly sessionId: SessionId
}

/** The three supported conversation-reuse modes. */
export type ConversationMode =
  | NewConversation
  | TaskSessionConversation
  | ReuseSessionConversation

/** Durable definition of one scheduled task. */
export interface ScheduledTaskRecord {
  /** Stable task identity. */
  readonly id: ScheduledTaskId
  /** Display name; non-empty after trimming. */
  readonly name: string
  /** Prompt text injected into the run's first user message. */
  readonly prompt: string
  /** Recurrence rule. */
  readonly schedule: ScheduleRule
  /** Model route for every run. */
  readonly model: ScheduledTaskModel
  /** Permission preset name applied to the run session. */
  readonly permission: string
  /** Conversation-reuse mode. */
  readonly conversation: ConversationMode
  /** Whether the scheduler may fire this task. */
  readonly enabled: boolean
  /** ISO-8601 creation instant. */
  readonly createdAt: string
  /** ISO-8601 instant of the latest durable mutation. */
  readonly updatedAt: string
  /** ISO-8601 instant of the latest run start, absent before the first run. */
  readonly lastRunAt?: string
  /** Session the latest run used; for `task-session` this is the dedicated session. */
  readonly lastRunSessionId?: SessionId
  /** Failure recorded on the latest run, absent when it started successfully. */
  readonly lastRunError?: ScheduledTaskRunError
}

/** A run could not start: stable machine code plus a human-readable reason. */
export interface ScheduledTaskRunError {
  readonly code: string
  readonly message: string
}

/** Public failure codes a scheduled-task operation can return. */
export type ScheduledTaskErrorCode =
  | 'invalid_name'
  | 'invalid_prompt'
  | 'invalid_schedule'
  | 'invalid_time_zone'
  | 'invalid_model'
  | 'invalid_permission'
  | 'invalid_conversation'
  | 'task_not_found'
  | 'internal'

/** A rejected public operation. */
export interface ScheduledTaskRejected {
  readonly ok: false
  readonly error: {
    readonly code: ScheduledTaskErrorCode
    readonly message: string
  }
}

/** A successful public operation. */
export interface ScheduledTaskSuccess<T> {
  readonly ok: true
  readonly value: T
}

/** Create request: a full task definition without the id or timestamps. */
export interface ScheduledTaskCreateRequest {
  readonly name: string
  readonly prompt: string
  readonly schedule: ScheduleRule
  readonly model: ScheduledTaskModel
  readonly permission: string
  readonly conversation: ConversationMode
  readonly enabled?: boolean
}

/** Update request: at least one mutable field, with the existing task id. */
export interface ScheduledTaskUpdateRequest {
  readonly id: ScheduledTaskId
  readonly name?: string
  readonly prompt?: string
  readonly schedule?: ScheduleRule
  readonly model?: ScheduledTaskModel
  readonly permission?: string
  readonly conversation?: ConversationMode
}

/** Delete request. */
export interface ScheduledTaskDeleteRequest {
  readonly id: ScheduledTaskId
}

/** Enable/disable request. */
export interface ScheduledTaskSetEnabledRequest {
  readonly id: ScheduledTaskId
  readonly enabled: boolean
}

/** Run-now request. */
export interface ScheduledTaskRunNowRequest {
  readonly id: ScheduledTaskId
}

/** List result: every task in creation order. */
export interface ScheduledTaskListValue {
  readonly items: readonly ScheduledTaskRecord[]
}

/** One run acknowledgement, shared by create-triggered and manual runs. */
export interface ScheduledTaskRunValue {
  readonly sessionId: SessionId
}

export type ScheduledTaskListResult =
  | ScheduledTaskSuccess<ScheduledTaskListValue>
  | ScheduledTaskRejected

export type ScheduledTaskCreateResult =
  | ScheduledTaskSuccess<ScheduledTaskRecord>
  | ScheduledTaskRejected

export type ScheduledTaskUpdateResult =
  | ScheduledTaskSuccess<ScheduledTaskRecord>
  | ScheduledTaskRejected

export type ScheduledTaskDeleteResult =
  | ScheduledTaskSuccess<{ readonly deleted: true }>
  | ScheduledTaskRejected

export type ScheduledTaskSetEnabledResult =
  | ScheduledTaskSuccess<ScheduledTaskRecord>
  | ScheduledTaskRejected

export type ScheduledTaskRunNowResult =
  | ScheduledTaskSuccess<ScheduledTaskRunValue>
  | ScheduledTaskRejected
