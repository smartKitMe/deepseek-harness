// @vitest-environment jsdom
/**
 * ScheduledTaskSection presentation rules: the list shows one card per task
 * with its schedule/model/permission/last-run summary; the add/edit form is a
 * single draft surface gated by local completeness checks; every mutation and
 * failure routes through the injected controller.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ScheduledTaskRecord } from '@deepseek-ai/dsh-scheduled-task/client'
import { ScheduledTaskSection } from '../src/client/ScheduledTaskSection.tsx'
import type { ScheduledTaskSectionProps } from '../src/client/ScheduledTaskSection.tsx'
import type { ScheduledTaskSettingsState, ScheduledTaskSettingsStore } from '../src/client/store.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

function record(overrides: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord {
  return {
    id: 'task-1' as ScheduledTaskRecord['id'],
    name: '每日日报',
    prompt: '总结日志',
    schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' },
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    permission: 'workspace-write',
    conversation: { kind: 'new' },
    enabled: true,
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    ...overrides,
  }
}

const MODELS = {
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'deepseek-v4-flash', name: 'Flash' },
      ],
    },
  ],
}

const READY: ScheduledTaskSettingsState = {
  status: 'ready',
  error: null,
  tasks: [],
  modelGroups: MODELS.groups,
  permissions: [
    { id: 'workspace-write', label: '工作区写入' },
    { id: 'danger-full-access', label: '完全访问' },
  ],
}

interface Actions {
  load: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  setEnabled: ReturnType<typeof vi.fn>
  runNow: ReturnType<typeof vi.fn>
}

function makeActions(): Actions {
  return {
    load: vi.fn(() => Promise.resolve()),
    create: vi.fn(() => Promise.resolve()),
    update: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    setEnabled: vi.fn(() => Promise.resolve()),
    runNow: vi.fn(() => Promise.resolve()),
  }
}

function renderSection(state: Partial<ScheduledTaskSettingsState> = {}, actions = makeActions()) {
  const store = createSnapshotStore<ScheduledTaskSettingsState>({ ...READY, ...state })
  const props = {
    ...actions,
    controller: actions as unknown as ScheduledTaskSettingsStore,
    useSnapshot: bindSnapshotSelector(store),
    t: (key: keyof typeof zh) => zh[key],
  } as unknown as ScheduledTaskSectionProps
  render(<ScheduledTaskSection {...props} />)
  return actions
}

/** Locate a task card by its id; the card key is the id but no text prints it, so use the name. */
function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest('li')
  /* v8 ignore next -- every rendered card prints its name */
  if (row === null) throw new Error(`no card for ${name}`)
  return row
}

describe('ScheduledTaskSection shell', () => {
  it('renders nothing while the shell has not injected', () => {
    const { container } = render(<ScheduledTaskSection />)
    expect(container.firstChild).toBeNull()
  })

  it('loads once when it first renders', async () => {
    const actions = renderSection({ status: 'idle' })
    await waitFor(() => { expect(actions.load).toHaveBeenCalledTimes(1) })
  })

  it('offers a retry when the whole load failed', () => {
    const actions = renderSection({ status: 'error', error: 'wire down' })
    expect(screen.getByText(`${zh.loadFailed}: wire down`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(actions.load).toHaveBeenCalledTimes(1)
  })

  it('shows the empty state when there are no tasks', () => {
    renderSection()
    expect(screen.getByText(zh.empty)).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.add })).toBeTruthy()
  })
})

describe('the task list', () => {
  it('summarizes each task and routes its row actions', async () => {
    const actions = renderSection({
      tasks: [
        record(),
        record({
          id: 'task-2' as ScheduledTaskRecord['id'],
          name: '每小时清理',
          schedule: { kind: 'interval', everySeconds: 3600 },
          model: { provider: 'unknown', model: 'unknown-model' },
          permission: 'unknown-perm',
          enabled: false,
        }),
        record({ id: 'task-3' as ScheduledTaskRecord['id'], name: '失败任务', lastRunAt: '2026-08-05T00:00:00.000Z', lastRunError: { code: 'internal', message: 'boom' } }),
      ],
    })

    // Cron summary, matched model/permission labels, never-run.
    const cron = rowFor('每日日报')
    expect(within(cron).getByText(`${zh.cron} · 0 9 * * *`)).toBeTruthy()
    expect(within(cron).getByText('deepseek-official / deepseek-v4-flash')).toBeTruthy()
    expect(within(cron).getByText('工作区写入')).toBeTruthy()
    expect(within(cron).getByText(zh.neverRun)).toBeTruthy()
    expect(within(cron).getByText(zh.enabled)).toBeTruthy()

    // Interval summary, unmatched model/permission fall back to raw ids.
    const interval = rowFor('每小时清理')
    expect(within(interval).getByText(zh.everySeconds.replace('{seconds}', '3600'))).toBeTruthy()
    expect(within(interval).getByText('unknown / unknown-model')).toBeTruthy()
    expect(within(interval).getByText('unknown-perm')).toBeTruthy()
    expect(within(interval).getByText(zh.disabled)).toBeTruthy()

    // A failed last run renders the failure badge, not the timestamp.
    expect(within(rowFor('失败任务')).getByText(zh.failed)).toBeTruthy()

    fireEvent.click(within(cron).getByRole('button', { name: zh.runNow }))
    fireEvent.click(within(interval).getByRole('button', { name: zh.enable }))
    fireEvent.click(within(cron).getByRole('button', { name: zh.disable }))
    fireEvent.click(within(cron).getByRole('button', { name: zh.delete }))

    await waitFor(() => {
      expect(actions.runNow).toHaveBeenCalledWith('task-1')
      expect(actions.setEnabled).toHaveBeenCalledWith('task-2', true)
      expect(actions.setEnabled).toHaveBeenCalledWith('task-1', false)
    })
    expect(screen.getByText(zh.deleteTitle)).toBeTruthy()
  })

  it('shows the running label while a run is in flight', () => {
    const actions = makeActions()
    let resolveRun!: () => void
    const pending = new Promise<void>((resolve) => { resolveRun = resolve })
    actions.runNow.mockReturnValueOnce(pending)
    renderSection({ tasks: [record()] }, actions)

    fireEvent.click(within(rowFor('每日日报')).getByRole('button', { name: zh.runNow }))
    expect(screen.getByText(zh.running)).toBeTruthy()
    resolveRun()
  })

  it('renders the timestamp for a successful last run', () => {
    renderSection({ tasks: [record({ lastRunAt: '2026-08-05T00:00:00.000Z' })] })
    const row = rowFor('每日日报')
    expect(within(row).queryByText(zh.neverRun)).toBeNull()
    expect(within(row).queryByText(zh.failed)).toBeNull()
    expect(within(row).getByText(/2026/)).toBeTruthy()
  })

  it('shows the working directory or the default', () => {
    renderSection({
      tasks: [
        record({ cwd: '/srv/reports' }),
        record({ id: 'task-2' as ScheduledTaskRecord['id'], name: '无目录' }),
      ],
    })
    expect(within(rowFor('每日日报')).getByText('/srv/reports')).toBeTruthy()
    expect(within(rowFor('无目录')).getByText(zh.cwdDefault)).toBeTruthy()
  })

  it('opens the delete confirmation and cancels it', () => {
    const actions = renderSection({ tasks: [record()] })

    fireEvent.click(within(rowFor('每日日报')).getByRole('button', { name: zh.delete }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(`${zh.deleteDescription} (每日日报)`)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: zh.cancel }))
    expect(screen.queryByText(zh.deleteTitle)).toBeNull()
    expect(actions.remove).not.toHaveBeenCalled()
  })

  it('confirms deletion through the controller', async () => {
    const actions = renderSection({ tasks: [record()] })

    fireEvent.click(within(rowFor('每日日报')).getByRole('button', { name: zh.delete }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: zh.confirmDelete }))

    await waitFor(() => { expect(actions.remove).toHaveBeenCalledWith('task-1') })
  })

  it('surfaces a delete failure', async () => {
    const actions = makeActions()
    actions.remove.mockRejectedValueOnce(new Error('delete refused'))
    renderSection({ tasks: [record()] }, actions)

    fireEvent.click(within(rowFor('每日日报')).getByRole('button', { name: zh.delete }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh.confirmDelete }))

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('delete refused') })
  })
})

describe('the create form', () => {
  it('gates the save button on local completeness', () => {
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    const save = () => screen.getByRole('button', { name: zh.add })
    expect(save()).toHaveProperty('disabled', true)

    fireEvent.change(screen.getByPlaceholderText(zh.namePlaceholder), { target: { value: '日报' } })
    expect(save()).toHaveProperty('disabled', true)

    fireEvent.change(screen.getByPlaceholderText(zh.promptPlaceholder), { target: { value: '总结' } })
    expect(save()).toHaveProperty('disabled', true)

    fireEvent.change(screen.getByRole('combobox', { name: zh.model }), { target: { value: 'deepseek-official\u0000deepseek-v4-flash' } })
    expect(save()).toHaveProperty('disabled', false)
  })

  it('blocks a blank cron expression', () => {
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByPlaceholderText(zh.namePlaceholder), { target: { value: '日报' } })
    fireEvent.change(screen.getByPlaceholderText(zh.promptPlaceholder), { target: { value: '总结' } })
    fireEvent.change(screen.getByRole('combobox', { name: zh.model }), { target: { value: 'deepseek-official\u0000deepseek-v4-flash' } })
    fireEvent.change(screen.getByPlaceholderText(zh.cronExpressionPlaceholder), { target: { value: '  ' } })

    expect(screen.getByRole('button', { name: zh.add })).toHaveProperty('disabled', true)
  })

  it('blocks a too-small or non-numeric interval', () => {
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByPlaceholderText(zh.namePlaceholder), { target: { value: '日报' } })
    fireEvent.change(screen.getByPlaceholderText(zh.promptPlaceholder), { target: { value: '总结' } })
    fireEvent.change(screen.getByRole('combobox', { name: zh.model }), { target: { value: 'deepseek-official\u0000deepseek-v4-flash' } })

    fireEvent.click(screen.getByRole('radio', { name: zh.scheduleInterval }))
    fireEvent.change(screen.getByPlaceholderText(zh.intervalSeconds), { target: { value: '30' } })
    expect(screen.getByRole('button', { name: zh.add })).toHaveProperty('disabled', true)

    fireEvent.change(screen.getByPlaceholderText(zh.intervalSeconds), { target: { value: 'abc' } })
    expect(screen.getByRole('button', { name: zh.add })).toHaveProperty('disabled', true)

    fireEvent.change(screen.getByPlaceholderText(zh.intervalSeconds), { target: { value: '3600' } })
    expect(screen.getByRole('button', { name: zh.add })).toHaveProperty('disabled', false)
  })

  it('blocks a session conversation without a session id', () => {
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByPlaceholderText(zh.namePlaceholder), { target: { value: '日报' } })
    fireEvent.change(screen.getByPlaceholderText(zh.promptPlaceholder), { target: { value: '总结' } })
    fireEvent.change(screen.getByRole('combobox', { name: zh.model }), { target: { value: 'deepseek-official\u0000deepseek-v4-flash' } })

    fireEvent.click(screen.getByRole('radio', { name: zh.conversationSession }))
    expect(screen.getByRole('button', { name: zh.add })).toHaveProperty('disabled', true)

    fireEvent.change(screen.getByPlaceholderText(zh.sessionIdPlaceholder), { target: { value: 'session-1' } })
    expect(screen.getByRole('button', { name: zh.add })).toHaveProperty('disabled', false)
  })

  it('creates a cron task through the controller', async () => {
    const actions = renderSection()

    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByPlaceholderText(zh.namePlaceholder), { target: { value: ' 日报 ' } })
    fireEvent.change(screen.getByPlaceholderText(zh.promptPlaceholder), { target: { value: ' 总结 ' } })
    fireEvent.change(screen.getByRole('combobox', { name: zh.model }), { target: { value: 'deepseek-official\u0000deepseek-v4-flash' } })
    fireEvent.change(screen.getByRole('combobox', { name: zh.permission }), { target: { value: 'danger-full-access' } })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))

    await waitFor(() => {
      expect(actions.create).toHaveBeenCalledWith({
        name: '日报',
        prompt: '总结',
        schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' },
        model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        permission: 'danger-full-access',
        conversation: { kind: 'new' },
      })
    })
  })

  it('creates a task-session interval task', async () => {
    const actions = renderSection()

    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByPlaceholderText(zh.namePlaceholder), { target: { value: '日报' } })
    fireEvent.change(screen.getByPlaceholderText(zh.promptPlaceholder), { target: { value: '总结' } })
    fireEvent.change(screen.getByRole('combobox', { name: zh.model }), { target: { value: 'deepseek-official\u0000deepseek-official' } })
    fireEvent.click(screen.getByRole('radio', { name: zh.scheduleInterval }))
    fireEvent.change(screen.getByPlaceholderText(zh.intervalSeconds), { target: { value: '7200' } })
    fireEvent.click(screen.getByRole('radio', { name: zh.conversationTaskSession }))
    fireEvent.click(screen.getByRole('button', { name: zh.add }))

    await waitFor(() => {
      expect(actions.create).toHaveBeenCalledWith({
        name: '日报',
        prompt: '总结',
        schedule: { kind: 'interval', everySeconds: 7200 },
        model: { provider: 'deepseek-official', model: 'deepseek-official' },
        permission: '',
        conversation: { kind: 'task-session' },
      })
    })
  })

  it('submits an explicit working directory', async () => {
    const actions = renderSection()

    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByPlaceholderText(zh.namePlaceholder), { target: { value: '日报' } })
    fireEvent.change(screen.getByPlaceholderText(zh.promptPlaceholder), { target: { value: '总结' } })
    fireEvent.change(screen.getByRole('combobox', { name: zh.model }), { target: { value: 'deepseek-official\u0000deepseek-v4-flash' } })
    fireEvent.change(screen.getByPlaceholderText(zh.cwdPlaceholder), { target: { value: ' /srv/reports ' } })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))

    await waitFor(() => {
      expect(actions.create).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/srv/reports' }))
    })
  })

  it('shows a save failure and keeps the form open', async () => {
    const actions = makeActions()
    actions.create.mockRejectedValueOnce(new Error('refused'))
    renderSection({}, actions)

    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByPlaceholderText(zh.namePlaceholder), { target: { value: '日报' } })
    fireEvent.change(screen.getByPlaceholderText(zh.promptPlaceholder), { target: { value: '总结' } })
    fireEvent.change(screen.getByRole('combobox', { name: zh.model }), { target: { value: 'deepseek-official\u0000deepseek-v4-flash' } })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('refused') })
  })

  it('toggles schedule and conversation radios and falls back a blank time zone', async () => {
    const actions = renderSection()

    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByPlaceholderText(zh.namePlaceholder), { target: { value: '日报' } })
    fireEvent.change(screen.getByPlaceholderText(zh.promptPlaceholder), { target: { value: '总结' } })
    fireEvent.change(screen.getByRole('combobox', { name: zh.model }), { target: { value: 'deepseek-official\u0000deepseek-v4-flash' } })

    fireEvent.click(screen.getByRole('radio', { name: zh.scheduleInterval }))
    fireEvent.click(screen.getByRole('radio', { name: zh.scheduleCron }))
    fireEvent.click(screen.getByRole('radio', { name: zh.conversationSession }))
    fireEvent.click(screen.getByRole('radio', { name: zh.conversationNew }))
    fireEvent.change(screen.getByPlaceholderText(zh.timeZone), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: zh.add }))

    await waitFor(() => {
      expect(actions.create).toHaveBeenCalledWith(expect.objectContaining({
        schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' },
        conversation: { kind: 'new' },
      }))
    })
  })

  it('resets the model when the select returns to the placeholder', () => {
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: zh.add }))
    fireEvent.change(screen.getByRole('combobox', { name: zh.model }), { target: { value: 'deepseek-official\u0000deepseek-v4-flash' } })
    fireEvent.change(screen.getByRole('combobox', { name: zh.model }), { target: { value: '' } })

    expect(screen.getByRole('button', { name: zh.add })).toHaveProperty('disabled', true)
  })
})

describe('the edit form', () => {
  it('seeds cron and session fields from the record and updates through the controller', async () => {
    const actions = renderSection({
      tasks: [record({ conversation: { kind: 'session', sessionId: 'session-9' as never }, cwd: '/srv/reports' })],
    })

    fireEvent.click(within(rowFor('每日日报')).getByRole('button', { name: zh.edit }))
    expect(screen.getByPlaceholderText(zh.namePlaceholder)).toHaveProperty('value', '每日日报')
    expect(screen.getByPlaceholderText(zh.cronExpressionPlaceholder)).toHaveProperty('value', '0 9 * * *')
    expect(screen.getByPlaceholderText(zh.timeZone)).toHaveProperty('value', 'UTC')
    expect(screen.getByPlaceholderText(zh.sessionIdPlaceholder)).toHaveProperty('value', 'session-9')
    expect(screen.getByPlaceholderText(zh.cwdPlaceholder)).toHaveProperty('value', '/srv/reports')

    fireEvent.change(screen.getByPlaceholderText(zh.namePlaceholder), { target: { value: '改名' } })
    fireEvent.click(screen.getByRole('button', { name: zh.save }))

    await waitFor(() => {
      expect(actions.update).toHaveBeenCalledWith(expect.objectContaining({
        id: 'task-1',
        name: '改名',
        schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' },
        conversation: { kind: 'session', sessionId: 'session-9' },
        cwd: '/srv/reports',
      }))
    })
  })

  it('seeds interval fields from an interval record and cancels', () => {
    const actions = renderSection({
      tasks: [record({ schedule: { kind: 'interval', everySeconds: 1800 } })],
    })

    fireEvent.click(within(rowFor('每日日报')).getByRole('button', { name: zh.edit }))
    expect(screen.getByPlaceholderText(zh.intervalSeconds)).toHaveProperty('value', '1800')
    fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
    expect(screen.queryByPlaceholderText(zh.intervalSeconds)).toBeNull()
    expect(actions.update).not.toHaveBeenCalled()
  })
})

describe('row failure handling', () => {
  it('surfaces a run-now failure', async () => {
    const actions = makeActions()
    actions.runNow.mockRejectedValueOnce(new Error('run refused'))
    renderSection({ tasks: [record()] }, actions)

    fireEvent.click(within(rowFor('每日日报')).getByRole('button', { name: zh.runNow }))

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('run refused') })
  })

  it('surfaces an enable-toggle failure', async () => {
    const actions = makeActions()
    actions.setEnabled.mockRejectedValueOnce(new Error('toggle refused'))
    renderSection({ tasks: [record()] }, actions)

    fireEvent.click(within(rowFor('每日日报')).getByRole('button', { name: zh.disable }))

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('toggle refused') })
  })
})
