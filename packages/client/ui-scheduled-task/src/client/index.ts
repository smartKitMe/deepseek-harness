/**
 * Scheduled-task settings plugin, browser half: one `settings.section` page
 * over the scheduled-task Remote. The section owns a store joined from the
 * Remote list plus the model catalog and permission settings; every mutation
 * writes through the Remote and reloads the list.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge (scheduledTasks namespace) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { ScheduledTasksRemote } from './store.ts'
import { ScheduledTaskSettingsStore } from './store.ts'
import { ScheduledTaskSection } from './ScheduledTaskSection.tsx'
import type { ScheduledTaskSectionInjected } from './ScheduledTaskSection.tsx'
import { en, zh } from './locales.ts'
import type { ScheduledTaskKey } from './locales.ts'

export type { ScheduledTaskSectionInjected, ScheduledTaskSectionProps } from './ScheduledTaskSection.tsx'
export type { ScheduledTaskKey } from './locales.ts'
export type {
  ScheduledTaskSettingsState, PermissionOption, ScheduledTasksRemote,
} from './store.ts'
export { permissionOptionsOf, unwrap } from './store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The scheduled-task settings page copy. */
    'settings.scheduled-task': ScheduledTaskKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.scheduled-task'

/** Required services for the section: slot registration, copy, and the Remote + connection. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'remote.scheduledTasks']

/**
 * Client plugin body: register the scheduled-task settings section.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-scheduled-task: copy dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  const remote: ScheduledTasksRemote = ctx.remote.scheduledTasks
  const controller = new ScheduledTaskSettingsStore(remote, connection.api)
  const useSnapshot = bindSnapshotSelector(controller.store)
  const t = ctx.locale.bind(NS) as ScheduledTaskSectionInjected['t']
  const injected = (): ScheduledTaskSectionInjected => ({ controller, useSnapshot, t })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'scheduled-task',
    order: 40,
    label: () => t('nav'),
    inject: injected,
  }, ScheduledTaskSection))
}
