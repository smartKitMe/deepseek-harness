/**
 * Pure schedule validation and next-run computation for scheduled tasks.
 * @module @deepseek-ai/dsh-scheduled-task
 */

import { Cron } from 'croner'
import type {
  CronSchedule,
  ScheduleRule,
  ScheduledTaskErrorCode,
} from './types.ts'

/** Fixed v1 lower bound for a fixed-rate task. */
export const MIN_INTERVAL_SECONDS = 60

/** Whether a candidate time-zone string is UTC or a plausible IANA zone. */
const IANA_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/

/** One validation failure with a stable public code. */
export class ScheduleValidationError extends Error {
  /** Stable public error discriminator. */
  readonly code: ScheduledTaskErrorCode

  /**
   * Construct a validation failure.
   * @param detail - the stable code and human-readable reason.
   */
  constructor(detail: { code: ScheduledTaskErrorCode; message: string }) {
    super(detail.message)
    this.name = 'ScheduleValidationError'
    this.code = detail.code
  }
}

/**
 * Canonicalize and validate an IANA time-zone selector.
 * @param value - Candidate `UTC` or IANA Area/Location name.
 * @returns the runtime's canonical IANA name.
 * @throws {@link ScheduleValidationError} when the zone is unusable.
 */
export function canonicalizeTimeZone(value: string): string {
  if (value.length === 0 || value.trim() !== value || (value !== 'UTC' && !IANA_ZONE.test(value))) {
    throw new ScheduleValidationError({
      code: 'invalid_time_zone',
      message: 'time_zone must be UTC or a valid IANA Area/Location name.',
    })
  }
  let canonical: string
  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone
  } catch (_error: unknown) {
    throw new ScheduleValidationError({
      code: 'invalid_time_zone',
      message: 'time_zone must be UTC or a valid IANA Area/Location name.',
    })
  }
  /* v8 ignore next -- Intl returns the requested canonical zone or an IANA canonical alias. */
  if (canonical !== 'UTC' && !IANA_ZONE.test(canonical)) {
    throw new ScheduleValidationError({
      code: 'invalid_time_zone',
      message: 'time_zone must resolve to UTC or an IANA Area/Location name.',
    })
  }
  return canonical
}

/**
 * Validate a cron expression and time zone, returning a normalized rule.
 * @param expression - candidate cron expression.
 * @param timeZone - candidate `UTC` or IANA zone.
 * @returns the normalized cron schedule.
 * @throws {@link ScheduleValidationError} when the expression or zone is invalid.
 */
export function resolveCronSchedule(expression: string, timeZone: string): CronSchedule {
  const trimmed = expression.trim()
  if (trimmed === '') {
    throw new ScheduleValidationError({
      code: 'invalid_schedule',
      message: 'cron expression must not be empty.',
    })
  }
  const zone = canonicalizeTimeZone(timeZone)
  try {
    // Construction validates the pattern; an invalid expression throws.
    new Cron(trimmed, { timezone: zone })
  } catch (error: unknown) {
    /* v8 ignore next -- croner only ever throws Error instances */
    const message = error instanceof Error ? error.message : 'cron expression is invalid.'
    throw new ScheduleValidationError({ code: 'invalid_schedule', message })
  }
  return { kind: 'cron', expression: trimmed, timeZone: zone }
}

/**
 * Compute the next run instant for one schedule.
 *
 * A cron rule evaluates from `from` (exclusive of a run that already started);
 * a fixed-rate rule runs `everySeconds` after `from`. Cron computes the next
 * matching instant directly; a cron expression with no future match returns
 * `undefined`.
 * @param schedule - normalized rule.
 * @param from - the instant to compute the next run after, in epoch ms.
 * @returns the next run instant in epoch ms, or `undefined` for a cron with no future match.
 */
export function nextRunAt(schedule: ScheduleRule, from: number): number | undefined {
  if (schedule.kind === 'interval') {
    return from + schedule.everySeconds * 1000
  }
  const cron = new Cron(schedule.expression, { timezone: schedule.timeZone })
  const next = cron.nextRun(new Date(from))
  return next === null ? undefined : next.getTime()
}
