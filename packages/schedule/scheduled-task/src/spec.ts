/**
 * Durable storage-domain declaration for scheduled tasks.
 * @module @deepseek-ai/dsh-scheduled-task/src/spec
 */

import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  ConversationMode,
  ScheduledTaskId,
  ScheduledTaskModel,
  ScheduledTaskRecord,
  ScheduledTaskRunError,
} from './types.ts'

const scheduledTaskId = z.string().min(1).transform(value => value as ScheduledTaskId)
const sessionId = z.string().min(1).transform(value => value as SessionId)

/** Runtime schema for a cron schedule. */
const cronScheduleSchema = z.object({
  kind: z.literal('cron'),
  expression: z.string().min(1),
  timeZone: z.string().min(1),
})

/** Runtime schema for a fixed-rate schedule. */
const intervalScheduleSchema = z.object({
  kind: z.literal('interval'),
  everySeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})

const scheduleSchema = z.discriminatedUnion('kind', [
  cronScheduleSchema,
  intervalScheduleSchema,
])

/** Runtime schema for the model route. */
const modelSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
}) as unknown as z.ZodType<ScheduledTaskModel>

const newConversationSchema = z.object({ kind: z.literal('new') })
const taskSessionConversationSchema = z.object({ kind: z.literal('task-session') })
const reuseSessionConversationSchema = z.object({
  kind: z.literal('session'),
  sessionId,
})

const conversationSchema = z.discriminatedUnion('kind', [
  newConversationSchema,
  taskSessionConversationSchema,
  reuseSessionConversationSchema,
]) as unknown as z.ZodType<ConversationMode>

const runErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
}) as unknown as z.ZodType<ScheduledTaskRunError>

/** Runtime schema for one durable task record. */
export const scheduledTaskRecordSchema = z.object({
  id: scheduledTaskId,
  name: z.string().min(1),
  prompt: z.string().min(1),
  schedule: scheduleSchema,
  model: modelSchema,
  permission: z.string().min(1),
  conversation: conversationSchema,
  cwd: z.string().min(1).optional(),
  enabled: z.boolean(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  lastRunAt: z.string().min(1).optional(),
  lastRunSessionId: sessionId.optional(),
  lastRunError: runErrorSchema.optional(),
}) as unknown as z.ZodType<ScheduledTaskRecord>

/**
 * The scheduled-task domain: one `tasks` table keyed by
 * {@link ScheduledTaskId}. The spec object is the single source of the
 * domain's identity, version, and schemas.
 */
export const scheduledTaskDomainSpec = defineDomain({
  name: 'scheduled_task',
  version: 0,
  tables: { tasks: domainTable<ScheduledTaskId, ScheduledTaskRecord>(scheduledTaskRecordSchema) },
})
