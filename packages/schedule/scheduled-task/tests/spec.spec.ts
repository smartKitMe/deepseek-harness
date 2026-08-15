import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { scheduledTaskDomainSpec, scheduledTaskRecordSchema } from '../src/spec.ts'
import type { ScheduledTaskRecord } from '../src/types.ts'

function record(overrides: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord {
  return {
    id: 'task-1' as ScheduledTaskRecord['id'],
    name: 'daily',
    prompt: 'run',
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

describe('scheduledTaskRecordSchema', () => {
  it('accepts a complete record', () => {
    expect(scheduledTaskRecordSchema.parse(record())).toMatchObject({ id: 'task-1' })
  })

  it('accepts an interval schedule and task-session conversation', () => {
    const parsed = scheduledTaskRecordSchema.parse(record({
      schedule: { kind: 'interval', everySeconds: 60 },
      conversation: { kind: 'task-session' },
      lastRunAt: '2026-08-05T01:00:00.000Z',
      lastRunSessionId: SessionId('session-1'),
      lastRunError: { code: 'internal', message: 'boom' },
    }))
    expect(parsed.schedule).toEqual({ kind: 'interval', everySeconds: 60 })
    expect(parsed.conversation).toEqual({ kind: 'task-session' })
  })

  it('accepts a reuse-session conversation', () => {
    expect(scheduledTaskRecordSchema.parse(record({
      conversation: { kind: 'session', sessionId: 'session-1' as never },
    })).conversation).toEqual({ kind: 'session', sessionId: 'session-1' })
  })

  it('rejects a blank name', () => {
    expect(() => scheduledTaskRecordSchema.parse(record({ name: '' }))).toThrow()
  })

  it('rejects a non-positive interval', () => {
    expect(() => scheduledTaskRecordSchema.parse(record({
      schedule: { kind: 'interval', everySeconds: 0 },
    }))).toThrow()
  })

  it('rejects an unknown conversation kind', () => {
    expect(() => scheduledTaskRecordSchema.parse(record({
      conversation: { kind: 'bogus' } as never,
    }))).toThrow()
  })
})

describe('scheduledTaskDomainSpec', () => {
  it('declares the scheduled_task domain with one tasks table', () => {
    expect(scheduledTaskDomainSpec.name).toBe('scheduled_task')
    expect(scheduledTaskDomainSpec.version).toBe(0)
    expect(Object.keys(scheduledTaskDomainSpec.tables)).toEqual(['tasks'])
  })
})
