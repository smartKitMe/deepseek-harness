/**
 * Scheduled-task settings store: the task list from the scheduled-task Remote
 * joined with the model catalog (`llm.models`) and permission preset names
 * (the permission Settings namespace). The Host stays the single fact source —
 * every mutation writes through the Remote and the section re-renders from the
 * next list.
 */

import type {
  IApiClient, ModelProviderGroup, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ConversationMode,
  ScheduledTaskCreateRequest,
  ScheduledTaskCreateResult,
  ScheduledTaskDeleteRequest,
  ScheduledTaskDeleteResult,
  ScheduledTaskListResult,
  ScheduledTaskListValue,
  ScheduledTaskRecord,
  ScheduledTaskRunNowRequest,
  ScheduledTaskRunNowResult,
  ScheduledTaskRunValue,
  ScheduledTaskSetEnabledRequest,
  ScheduledTaskSetEnabledResult,
  ScheduledTaskUpdateRequest,
  ScheduledTaskUpdateResult,
  ScheduleRule,
} from '@deepseek-ai/dsh-scheduled-task/client'
import { nodeAtPath, rehydrateSchema } from '@deepseek-ai/dsh-client-schema-form'
import type { SchemaNode } from '@deepseek-ai/dsh-client-schema-form'

/** The scheduled-task Remote namespace the section reads and writes through. */
export interface ScheduledTasksRemote {
  list(): Promise<RemoteResult<ScheduledTaskListResult>>
  create(request: ScheduledTaskCreateRequest): Promise<RemoteResult<ScheduledTaskCreateResult>>
  update(request: ScheduledTaskUpdateRequest): Promise<RemoteResult<ScheduledTaskUpdateResult>>
  delete(request: ScheduledTaskDeleteRequest): Promise<RemoteResult<ScheduledTaskDeleteResult>>
  setEnabled(request: ScheduledTaskSetEnabledRequest): Promise<RemoteResult<ScheduledTaskSetEnabledResult>>
  runNow(request: ScheduledTaskRunNowRequest): Promise<RemoteResult<ScheduledTaskRunNowResult>>
}

/** The business value a `list` result carries once both envelopes unwrap. */
export type ScheduledTaskListItems = ScheduledTaskListValue
/** The business value a `runNow` result carries once both envelopes unwrap. */
export type ScheduledTaskRunAck = ScheduledTaskRunValue

/** The permission Settings namespace name. */
export const PERMISSION_SETTINGS_NS = 'permission'

/** One selectable permission preset. */
export interface PermissionOption {
  /** Preset name submitted to the task. */
  id: string
  /** Host-supplied label, falling back to the preset name. */
  label: string
}

/** Section snapshot. */
export interface ScheduledTaskSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text. */
  error: string | null
  /** Tasks in creation order. */
  tasks: readonly ScheduledTaskRecord[]
  /** Model catalog for the model picker. */
  modelGroups: readonly ModelProviderGroup[]
  /** Permission presets for the permission picker. */
  permissions: readonly PermissionOption[]
}

/** Human text for a rejected wire call. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ConstChoice {
  type: string
  value?: unknown
  meta?: { description?: unknown }
}

/**
 * Read the permission preset names encoded by the host's `defaultPreset`
 * settings schema, mirroring the permission-presets settings row.
 * @param view - the permission namespace descriptor, when mounted.
 * @returns selectable presets, or an empty list when the namespace is absent.
 */
export function permissionOptionsOf(view: SettingsNamespaceView | undefined): PermissionOption[] {
  if (view === undefined) return []
  const node = nodeAtPath(rehydrateSchema(view.schema), ['defaultPreset'])
  if (node === undefined) return []
  const rawChoices = node.type === 'union'
    ? (node.list as SchemaNode[] | undefined) ?? []
    : [node]
  return rawChoices.flatMap((candidate) => {
    const choice = candidate as unknown as ConstChoice
    if (choice.type !== 'const' || typeof choice.value !== 'string') return []
    const described = choice.meta?.description
    return [{
      id: choice.value,
      label: typeof described === 'string' && described.length > 0 ? described : choice.value,
    }]
  })
}

/** A scheduled-task business result inside the Remote transport envelope. */
type CarriedBusiness<T> = RemoteResult<
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
>

/**
 * Unwrap one Remote business result: a transport/assembly failure rejects, a
 * business rejection throws with the stable code+message, and a success value
 * passes through.
 * @param result - the Remote result to unwrap.
 * @returns the business value.
 */
export function unwrap<T>(result: CarriedBusiness<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const business = result.value
  if (!business.ok) throw new Error(`${business.error.code}: ${business.error.message}`)
  return business.value
}

/** The scheduled-task settings page controller. */
export class ScheduledTaskSettingsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<ScheduledTaskSettingsState> = createSnapshotStore<ScheduledTaskSettingsState>({
    status: 'idle', error: null, tasks: [], modelGroups: [], permissions: [],
  })

  /** Latest load wins; an older response never overwrites a newer one. */
  private generation = 0

  /**
   * @param remote - the scheduled-task Remote namespace.
   * @param api - the wire face for the model catalog and settings namespace.
   */
  constructor(
    private readonly remote: ScheduledTasksRemote,
    private readonly api: Pick<IApiClient, 'llm' | 'settings'>,
  ) {}

  /**
   * Refresh the whole page snapshot: task list, model catalog, and permission
   * presets. A failure keeps the last good data and surfaces the error.
   * @returns nothing; the snapshot carries the outcome.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    let tasks: readonly ScheduledTaskRecord[]
    let modelGroups: readonly ModelProviderGroup[]
    let permissions: readonly PermissionOption[]
    try {
      const [taskResult, modelsResponse, settingsResponse] = await Promise.all([
        this.remote.list(),
        this.api.llm.models({}),
        this.api.settings.describe({}),
      ])
      tasks = unwrap(taskResult).items
      if (!modelsResponse.result.ok) throw new Error(modelsResponse.result.error.message)
      modelGroups = modelsResponse.result.value.groups
      if (!settingsResponse.result.ok) throw new Error(settingsResponse.result.error.message)
      const view = settingsResponse.result.value.namespaces.find(entry => entry.ns === PERMISSION_SETTINGS_NS)
      permissions = permissionOptionsOf(view)
    } catch (error) {
      if (generation !== this.generation) return
      this.store.update((s) => {
        s.status = 'error'
        s.error = messageOf(error)
      })
      return
    }
    if (generation !== this.generation) return
    this.store.update((s) => {
      s.status = 'ready'
      s.error = null
      s.tasks = tasks
      s.modelGroups = modelGroups
      s.permissions = permissions
    })
  }

  /** Create one task and refresh the list. */
  async create(request: ScheduledTaskCreateRequest): Promise<void> {
    unwrap(await this.remote.create(request))
    await this.load()
  }

  /** Update one task and refresh the list. */
  async update(request: ScheduledTaskUpdateRequest): Promise<void> {
    unwrap(await this.remote.update(request))
    await this.load()
  }

  /** Delete one task and refresh the list. */
  async remove(id: ScheduledTaskRecord['id']): Promise<void> {
    unwrap(await this.remote.delete({ id }))
    await this.load()
  }

  /** Enable or disable one task and refresh the list. */
  async setEnabled(id: ScheduledTaskRecord['id'], enabled: boolean): Promise<void> {
    unwrap(await this.remote.setEnabled({ id, enabled }))
    await this.load()
  }

  /** Run one task now and refresh the list (the run advances lastRunAt). */
  async runNow(id: ScheduledTaskRecord['id']): Promise<void> {
    unwrap(await this.remote.runNow({ id }))
    await this.load()
  }
}

/** Re-export the domain vocabulary the form consumes. */
export type { ConversationMode, ScheduleRule }
