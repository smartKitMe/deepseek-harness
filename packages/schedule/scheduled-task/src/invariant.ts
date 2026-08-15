/** Package-owned invariant companion. @module @deepseek-ai/dsh-scheduled-task/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-scheduled-task'

/** Cordis companion plugin name. */
export const name = 'scheduled-task-invariant'
/** Services required before the companion can reserve and check package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the service is the sole writer of its domain table,
 * the domain schema validates every record on reopen, and the scheduler loop
 * reads only through the same service's list path. No second authority exists.
 */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['scheduledTasks'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
