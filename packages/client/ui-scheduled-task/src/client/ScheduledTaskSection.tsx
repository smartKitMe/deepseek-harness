/**
 * Scheduled-task settings section: the task list plus a create/edit form.
 * Every mutation writes through the Remote; the list re-renders from the next
 * store snapshot. The form is a single editing surface — one draft at a time,
 * opened for create or one existing task.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, IconPlusOutline16, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ConversationMode, ScheduledTaskCreateRequest, ScheduledTaskRecord,
  ScheduledTaskUpdateRequest, ScheduleRule,
} from '@deepseek-ai/dsh-scheduled-task/client'
import { messageOf } from './store.ts'
import type { ScheduledTaskSettingsState } from './store.ts'
import type { en } from './locales.ts'
import styles from './ScheduledTaskSection.module.css'

/** Injected dependencies of {@link ScheduledTaskSection} (slot `inject`). */
export interface ScheduledTaskSectionInjected {
  hooks: {
    /** Scheduled-task settings snapshot bound by the renderer as useScheduledTasks. */
    scheduledTasks: SnapshotStore<ScheduledTaskSettingsState>
  }
  /** Load the page snapshot when the section first renders. */
  load: () => Promise<void>
  /** Create one task and refresh the list. */
  create: (request: ScheduledTaskCreateRequest) => Promise<void>
  /** Update one task and refresh the list. */
  update: (request: ScheduledTaskUpdateRequest) => Promise<void>
  /** Delete one task and refresh the list. */
  remove: (id: ScheduledTaskRecord['id']) => Promise<void>
  /** Enable or disable one task and refresh the list. */
  setEnabled: (id: ScheduledTaskRecord['id'], enabled: boolean) => Promise<void>
  /** Run one task now and refresh the list. */
  runNow: (id: ScheduledTaskRecord['id']) => Promise<void>
}

/** Fully-composed props: the runtime and locale seats plus the bound inject face. */
type LoadedProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.scheduled-task'>
  & InjectFace<ScheduledTaskSectionInjected>

/** Props accepted by the shell gate; injected members are optional until the slot injects. */
export type ScheduledTaskSectionProps = Partial<LoadedProps>

/** A complete task form draft. */
interface Draft {
  name: string
  prompt: string
  scheduleKind: 'cron' | 'interval'
  cronExpression: string
  timeZone: string
  intervalSeconds: string
  provider: string
  model: string
  permission: string
  conversationKind: ConversationMode['kind']
  sessionId: string
  cwd: string
}

/** A blank create draft. */
function emptyDraft(): Draft {
  return {
    name: '',
    prompt: '',
    scheduleKind: 'cron',
    cronExpression: '0 9 * * *',
    timeZone: 'UTC',
    intervalSeconds: '3600',
    provider: '',
    model: '',
    permission: '',
    conversationKind: 'new',
    sessionId: '',
    cwd: '',
  }
}

/** A draft seeded from an existing task. */
function draftOf(record: ScheduledTaskRecord): Draft {
  return {
    name: record.name,
    prompt: record.prompt,
    scheduleKind: record.schedule.kind,
    cronExpression: record.schedule.kind === 'cron' ? record.schedule.expression : '0 9 * * *',
    timeZone: record.schedule.kind === 'cron' ? record.schedule.timeZone : 'UTC',
    intervalSeconds: record.schedule.kind === 'interval' ? String(record.schedule.everySeconds) : '3600',
    provider: record.model.provider,
    model: record.model.model,
    permission: record.permission,
    conversationKind: record.conversation.kind,
    sessionId: record.conversation.kind === 'session' ? record.conversation.sessionId : '',
    cwd: record.cwd ?? '',
  }
}

/** Flatten the catalog into `provider/model` option ids plus a display label. */
function modelOptions(groups: readonly ModelProviderGroup[]): { id: string; label: string }[] {
  return groups.flatMap(group => group.models.map(entry => ({
    id: `${group.id}\u0000${entry.id}`,
    label: group.id === entry.id ? entry.id : `${group.id} / ${entry.id}`,
  })))
}

/** True when a draft needs a session id but has a blank one. */
function draftComplete(draft: Draft): boolean {
  if (draft.name.trim() === '' || draft.prompt.trim() === '') return false
  if (draft.provider === '' || draft.model === '') return false
  if (draft.scheduleKind === 'cron' && draft.cronExpression.trim() === '') return false
  if (draft.scheduleKind === 'interval') {
    const seconds = Number(draft.intervalSeconds)
    if (!Number.isSafeInteger(seconds) || seconds < 60) return false
  }
  if (draft.conversationKind === 'session' && draft.sessionId.trim() === '') return false
  return true
}

/** Build the schedule rule from the draft. */
function scheduleOf(draft: Draft): ScheduleRule {
  if (draft.scheduleKind === 'cron') {
    return { kind: 'cron', expression: draft.cronExpression.trim(), timeZone: draft.timeZone.trim() || 'UTC' }
  }
  return { kind: 'interval', everySeconds: Number(draft.intervalSeconds) }
}

/** Build the conversation mode from the draft. */
function conversationOf(draft: Draft): ConversationMode {
  if (draft.conversationKind === 'task-session') return { kind: 'task-session' }
  if (draft.conversationKind === 'session') return { kind: 'session', sessionId: draft.sessionId.trim() as never }
  return { kind: 'new' }
}

/** Human schedule summary for one task row. */
function scheduleLabel(record: ScheduledTaskRecord, t: (key: keyof typeof en) => string): string {
  if (record.schedule.kind === 'cron') {
    return `${t('cron')} · ${record.schedule.expression}`
  }
  return t('everySeconds').replace('{seconds}', String(record.schedule.everySeconds))
}

/**
 * Render the scheduled-task settings section content column.
 * @param props - slot-delivered composed props.
 * @returns the section, or null while the shell has not injected yet.
 */
export function ScheduledTaskSection(props: ScheduledTaskSectionProps): ReactNode {
  const { load, useScheduledTasks, t } = props
  if (load === undefined || useScheduledTasks === undefined || t === undefined) return null
  return <Loaded {...(props as LoadedProps)} />
}

function Loaded(props: LoadedProps): ReactNode {
  const { create, update, remove, setEnabled, runNow, load, t } = props
  const state = props.useScheduledTasks(snapshot => snapshot)
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [editingId, setEditingId] = useState<ScheduledTaskRecord['id'] | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTaskRecord | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [actionId, setActionId] = useState<string | undefined>(undefined)

  if (state.status === 'idle') void load()
  if (state.status === 'error') {
    /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
    const errorText = state.error ?? ''
    return (
      <div className={styles['section']}>
        <p className={styles['error']}>{`${t('loadFailed')}: ${errorText}`}</p>
        <button type="button" className={styles['secondaryButton']} onClick={() => { void load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }

  const options = modelOptions(state.modelGroups)
  const modelOf = (provider: string, model: string): string => `${provider}\u0000${model}`

  const openCreate = (): void => {
    setDraft(emptyDraft())
    setEditingId(undefined)
    setFailure(undefined)
  }

  const openEdit = (record: ScheduledTaskRecord): void => {
    setDraft(draftOf(record))
    setEditingId(record.id)
    setFailure(undefined)
  }

  const closeForm = (): void => {
    /* v8 ignore next -- the cancel control is disabled while saving */
    if (saving) return
    setDraft(undefined)
    setEditingId(undefined)
    setFailure(undefined)
  }

  const save = (): void => {
    /* v8 ignore next -- the save control only renders with a draft and is disabled while saving */
    if (draft === undefined || saving) return
    setSaving(true)
    setFailure(undefined)
    const cwd = draft.cwd.trim()
    const request = {
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      schedule: scheduleOf(draft),
      model: { provider: draft.provider, model: draft.model },
      permission: draft.permission,
      conversation: conversationOf(draft),
      ...cwd === '' ? {} : { cwd },
    }
    const operation = editingId === undefined
      ? create(request)
      : update({ id: editingId, ...request })
    operation.then(
      () => {
        setDraft(undefined)
        setEditingId(undefined)
      },
      (error: unknown) => { setFailure(messageOf(error)) },
    ).finally(() => { setSaving(false) })
  }

  const runTask = (record: ScheduledTaskRecord): void => {
    setActionId(record.id)
    void runNow(record.id)
      .catch((error: unknown) => { setFailure(messageOf(error)) })
      .finally(() => { setActionId(undefined) })
  }

  const toggleEnabled = (record: ScheduledTaskRecord): void => {
    void setEnabled(record.id, !record.enabled)
      .catch((error: unknown) => { setFailure(messageOf(error)) })
  }

  const closeDelete = (): void => {
    /* v8 ignore next -- the dialog close control is disabled while deleting */
    if (deleting) return
    setDeleteTarget(undefined)
  }

  const confirmDelete = (): void => {
    /* v8 ignore next -- the confirm control only renders with a target and is disabled while deleting */
    if (deleteTarget === undefined || deleting) return
    setDeleting(true)
    void remove(deleteTarget.id)
      .then(() => { setDeleteTarget(undefined) })
      .catch((error: unknown) => { setFailure(messageOf(error)) })
      .finally(() => { setDeleting(false) })
  }

  const editingRecord = editingId === undefined
    ? undefined
    : state.tasks.find(task => task.id === editingId)

  return (
    <div className={styles['section']}>
      <h2 className={styles['title']}>{t('title')}</h2>
      <p className={styles['intro']}>{t('intro')}</p>
      {failure === undefined ? null : <p className={styles['error']} role="alert">{failure}</p>}
      {draft === undefined
        ? (
          <>
            {state.tasks.length === 0
              ? <p className={styles['empty']}>{t('empty')}</p>
              : (
                <ul className={styles['rows']}>
                  {state.tasks.map((record) => {
                    const modelId = modelOf(record.model.provider, record.model.model)
                    const modelLabel = options.find(option => option.id === modelId)?.label
                      ?? `${record.model.provider} / ${record.model.model}`
                    const permissionLabel = state.permissions.find(option => option.id === record.permission)?.label
                      ?? record.permission
                    return (
                      <li key={record.id} className={styles['rowCard']}>
                        <div className={styles['rowHead']}>
                          <span className={styles['rowName']}>{record.name}</span>
                          <span className={record.enabled ? styles['stateEnabled'] : styles['stateDisabled']}>
                            {record.enabled ? t('enabled') : t('disabled')}
                          </span>
                        </div>
                        <dl className={styles['rowMeta']}>
                          <div><dt>{t('schedule')}</dt><dd>{scheduleLabel(record, t)}</dd></div>
                          <div><dt>{t('model')}</dt><dd>{modelLabel}</dd></div>
                          <div><dt>{t('permission')}</dt><dd>{permissionLabel}</dd></div>
                          <div><dt>{t('cwd')}</dt><dd>{record.cwd ?? t('cwdDefault')}</dd></div>
                          <div>
                            <dt>{t('lastRun')}</dt>
                            <dd>
                              {record.lastRunAt === undefined
                                ? t('neverRun')
                                : record.lastRunError === undefined
                                  ? new Date(record.lastRunAt).toLocaleString()
                                  : t('failed')}
                            </dd>
                          </div>
                        </dl>
                        <div className={styles['rowActions']}>
                          <button
                            type="button"
                            className={styles['secondaryButton']}
                            onClick={() => { runTask(record) }}
                          >
                            {actionId === record.id ? t('running') : t('runNow')}
                          </button>
                          <button
                            type="button"
                            className={styles['secondaryButton']}
                            onClick={() => { toggleEnabled(record) }}
                          >
                            {record.enabled ? t('disable') : t('enable')}
                          </button>
                          <button
                            type="button"
                            className={styles['secondaryButton']}
                            onClick={() => { openEdit(record) }}
                          >
                            {t('edit')}
                          </button>
                          <button
                            type="button"
                            className={styles['secondaryButton']}
                            onClick={() => { setDeleteTarget(record) }}
                          >
                            {t('delete')}
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            <button type="button" className={styles['addButton']} onClick={openCreate}>
              <IconPlusOutline16 size={14} />
              {t('add')}
            </button>
          </>
        )
        : (
          <Form
            draft={draft}
            setDraft={setDraft}
            options={options}
            permissions={state.permissions}
            t={t}
            saving={saving}
            editingRecord={editingRecord}
            onSave={save}
            onCancel={closeForm}
          />
        )}
      <Modal
        open={deleteTarget !== undefined}
        onClose={closeDelete}
        title={t('deleteTitle')}
        closeLabel={t('close')}
        description={deleteTarget === undefined ? '' : `${t('deleteDescription')} (${deleteTarget.name})`}
        className={styles['deleteDialog'] as string}
        footer={(
          <>
            <Button variant="outline" autoFocus disabled={deleting} onClick={closeDelete}>
              {t('cancel')}
            </Button>
            <Button variant="outline" className={styles['deleteConfirm']} disabled={deleting} onClick={confirmDelete}>
              {deleting ? t('deleting') : t('confirmDelete')}
            </Button>
          </>
        )}
      />
    </div>
  )
}

/** A create-or-edit form over one task draft. */
function Form(props: {
  draft: Draft
  setDraft: (next: Draft) => void
  options: readonly { id: string; label: string }[]
  permissions: readonly { id: string; label: string }[]
  t: (key: keyof typeof en) => string
  saving: boolean
  editingRecord: ScheduledTaskRecord | undefined
  onSave: () => void
  onCancel: () => void
}): ReactNode {
  const { draft, setDraft, options, permissions, t, saving, editingRecord, onSave, onCancel } = props
  const complete = draftComplete(draft)
  return (
    <div className={styles['form']}>
      <label className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('name')}</span>
        <Input
          value={draft.name}
          placeholder={t('namePlaceholder')}
          onChange={(event) => { setDraft({ ...draft, name: event.target.value }) }}
        />
      </label>
      <label className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('prompt')}</span>
        <textarea
          className={styles['textarea']}
          value={draft.prompt}
          placeholder={t('promptPlaceholder')}
          onChange={(event) => { setDraft({ ...draft, prompt: event.target.value }) }}
        />
      </label>

      <fieldset className={styles['fieldGroup']}>
        <legend className={styles['fieldLabel']}>{t('schedule')}</legend>
        <label className={styles['radio']}>
          <input
            type="radio"
            name="scheduleKind"
            checked={draft.scheduleKind === 'cron'}
            onChange={() => { setDraft({ ...draft, scheduleKind: 'cron' }) }}
          />
          {t('scheduleCron')}
        </label>
        <label className={styles['radio']}>
          <input
            type="radio"
            name="scheduleKind"
            checked={draft.scheduleKind === 'interval'}
            onChange={() => { setDraft({ ...draft, scheduleKind: 'interval' }) }}
          />
          {t('scheduleInterval')}
        </label>
        {draft.scheduleKind === 'cron'
          ? (
            <>
              <Input
                value={draft.cronExpression}
                placeholder={t('cronExpressionPlaceholder')}
                onChange={(event) => { setDraft({ ...draft, cronExpression: event.target.value }) }}
              />
              <Input
                value={draft.timeZone}
                placeholder={t('timeZone')}
                onChange={(event) => { setDraft({ ...draft, timeZone: event.target.value }) }}
              />
            </>
          )
          : (
            <Input
              type="number"
              value={draft.intervalSeconds}
              placeholder={t('intervalSeconds')}
              onChange={(event) => { setDraft({ ...draft, intervalSeconds: event.target.value }) }}
            />
          )}
      </fieldset>

      <label className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('model')}</span>
        <select
          className={styles['select']}
          value={draft.provider === '' || draft.model === '' ? '' : `${draft.provider}\u0000${draft.model}`}
          onChange={(event) => {
            const [provider, model] = event.target.value.split('\u0000')
            /* v8 ignore next -- split() always yields a first element, so provider is never undefined */
            const resolvedProvider = provider ?? ''
            setDraft({ ...draft, provider: resolvedProvider, model: model ?? '' })
          }}
        >
          <option value="" disabled>{t('modelPlaceholder')}</option>
          {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </label>

      <label className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('permission')}</span>
        <select
          className={styles['select']}
          value={draft.permission}
          onChange={(event) => { setDraft({ ...draft, permission: event.target.value }) }}
        >
          <option value="" disabled>{t('permissionPlaceholder')}</option>
          {permissions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </label>

      <fieldset className={styles['fieldGroup']}>
        <legend className={styles['fieldLabel']}>{t('conversation')}</legend>
        <label className={styles['radio']}>
          <input
            type="radio"
            name="conversationKind"
            checked={draft.conversationKind === 'new'}
            onChange={() => { setDraft({ ...draft, conversationKind: 'new' }) }}
          />
          {t('conversationNew')}
        </label>
        <label className={styles['radio']}>
          <input
            type="radio"
            name="conversationKind"
            checked={draft.conversationKind === 'task-session'}
            onChange={() => { setDraft({ ...draft, conversationKind: 'task-session' }) }}
          />
          {t('conversationTaskSession')}
        </label>
        <label className={styles['radio']}>
          <input
            type="radio"
            name="conversationKind"
            checked={draft.conversationKind === 'session'}
            onChange={() => { setDraft({ ...draft, conversationKind: 'session' }) }}
          />
          {t('conversationSession')}
        </label>
        {draft.conversationKind === 'session'
          ? (
            <Input
              value={draft.sessionId}
              placeholder={t('sessionIdPlaceholder')}
              onChange={(event) => { setDraft({ ...draft, sessionId: event.target.value }) }}
            />
          )
          : null}
      </fieldset>

      <label className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('cwd')}</span>
        <Input
          value={draft.cwd}
          placeholder={t('cwdPlaceholder')}
          onChange={(event) => { setDraft({ ...draft, cwd: event.target.value }) }}
        />
      </label>

      <div className={styles['formActions']}>
        <Button variant="outline" disabled={saving} onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button variant="primary" disabled={!complete || saving} onClick={onSave}>
          {saving ? t('saving') : editingRecord === undefined ? t('add') : t('save')}
        </Button>
      </div>
    </div>
  )
}
