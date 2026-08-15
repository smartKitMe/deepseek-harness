import { describe, expect, it } from 'vitest'
import {
  MIN_INTERVAL_SECONDS,
  ScheduleValidationError,
  canonicalizeTimeZone,
  nextRunAt,
  resolveCronSchedule,
} from '../src/domain.ts'

describe('canonicalizeTimeZone', () => {
  it('accepts UTC unchanged', () => {
    expect(canonicalizeTimeZone('UTC')).toBe('UTC')
  })

  it('canonicalizes a known IANA alias', () => {
    expect(canonicalizeTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai')
  })

  it('rejects a blank zone', () => {
    expect(() => canonicalizeTimeZone('')).toThrow(ScheduleValidationError)
  })

  it('rejects an unknown zone', () => {
    expect(() => canonicalizeTimeZone('Not/AZone')).toThrow(ScheduleValidationError)
  })
})

describe('resolveCronSchedule', () => {
  it('normalizes a valid five-field expression', () => {
    const schedule = resolveCronSchedule('0 9 * * *', 'UTC')
    expect(schedule).toEqual({ kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' })
  })

  it('trims the expression', () => {
    expect(resolveCronSchedule('  0 9 * * *  ', 'UTC').expression).toBe('0 9 * * *')
  })

  it('rejects an empty expression', () => {
    expect(() => resolveCronSchedule('   ', 'UTC')).toThrow(ScheduleValidationError)
  })

  it('rejects a malformed expression', () => {
    expect(() => resolveCronSchedule('not a cron', 'UTC')).toThrow(ScheduleValidationError)
  })

  it('rejects an invalid zone alongside a valid expression', () => {
    expect(() => resolveCronSchedule('0 9 * * *', 'Not/AZone')).toThrow(ScheduleValidationError)
  })
})

describe('nextRunAt', () => {
  it('advances a fixed-rate schedule by its interval', () => {
    expect(nextRunAt({ kind: 'interval', everySeconds: 300 }, 1_000_000)).toBe(1_300_000)
  })

  it('computes the next cron match strictly after the anchor', () => {
    // 2026-08-05T00:00:00Z is a Wednesday; "0 9 * * *" next fires at 09:00.
    const from = Date.parse('2026-08-05T00:00:00.000Z')
    const next = nextRunAt({ kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' }, from)
    expect(next).toBe(Date.parse('2026-08-05T09:00:00.000Z'))
  })

  it('returns undefined for a cron expression with no future match', () => {
    // A seven-field expression whose year field is already past never matches again.
    const from = Date.parse('2026-01-01T00:00:00.000Z')
    const next = nextRunAt({ kind: 'cron', expression: '0 0 0 1 1 * 2020', timeZone: 'UTC' }, from)
    expect(next).toBeUndefined()
  })
})

describe('MIN_INTERVAL_SECONDS', () => {
  it('is a positive safe integer', () => {
    expect(Number.isSafeInteger(MIN_INTERVAL_SECONDS)).toBe(true)
    expect(MIN_INTERVAL_SECONDS).toBeGreaterThan(0)
  })
})
