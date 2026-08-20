// @vitest-environment node
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type {
  ModelProviderGroup, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import { SettingsSchemaService } from '@deepseek-ai/dsh-client-ui-settings/src/client/schema.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ScheduledTaskListResult, ScheduledTaskRecord,
} from '@deepseek-ai/dsh-scheduled-task/client'
import {
  ScheduledTaskSettingsStore, messageOf, permissionOptionsOf, unwrap,
} from '../src/client/store.ts'

/** A real settings schema service over the fresh test context. */
const schema = new SettingsSchemaService(new Context())

/** A serialized schemastery union of const choices over the permission presets. */
const permissionSchema = {
  uid: 4,
  refs: {
    1: { type: 'const', value: 'workspace-write', meta: { description: 'Workspace write' } },
    2: { type: 'const', value: 'danger-full-access', meta: { description: 'Full access' } },
    3: { type: 'union', list: [1, 2] },
    4: { type: 'object', dict: { defaultPreset: 3 } },
  },
}

function permissionView(): SettingsNamespaceView {
  return {
    ns: 'permission',
    schema: permissionSchema,
    value: { defaultPreset: 'workspace-write' },
    base: {},
    user: {},
  } as unknown as SettingsNamespaceView
}

describe('permissionOptionsOf', () => {
  it('reads preset ids and labels from the settings schema', () => {
    expect(permissionOptionsOf(permissionView(), schema)).toEqual([
      { id: 'workspace-write', label: 'Workspace write' },
      { id: 'danger-full-access', label: 'Full access' },
    ])
  })

  it('returns an empty list when the namespace is absent', () => {
    expect(permissionOptionsOf(undefined, schema)).toEqual([])
  })

  it('returns an empty list when the defaultPreset node is missing', () => {
    expect(permissionOptionsOf({
      ns: 'permission',
      schema: { uid: 1, refs: { 1: { type: 'object', dict: {} } } },
      value: {},
    } as unknown as SettingsNamespaceView, schema)).toEqual([])
  })

  it('skips non-const choices and falls back to the id as a label', () => {
    expect(permissionOptionsOf({
      ns: 'permission',
      schema: {
        uid: 5,
        refs: {
          1: { type: 'const', value: 'a', meta: {} },
          2: { type: 'const', value: 'b' },
          3: { type: 'const', value: 42 },
          4: { type: 'union', list: [1, 2, 3] },
          5: { type: 'object', dict: { defaultPreset: 4 } },
        },
      },
      value: {},
    } as unknown as SettingsNamespaceView, schema)).toEqual([
      { id: 'a', label: 'a' },
      { id: 'b', label: 'b' },
    ])
  })

  it('treats a listless union as no choices', () => {
    expect(permissionOptionsOf({
      ns: 'permission',
      schema: {
        uid: 2,
        refs: {
          1: { type: 'union' },
          2: { type: 'object', dict: { defaultPreset: 1 } },
        },
      },
      value: {},
    } as unknown as SettingsNamespaceView, schema)).toEqual([])
  })

  it('reads a single non-union const default', () => {
    expect(permissionOptionsOf({
      ns: 'permission',
      schema: {
        uid: 2,
        refs: {
          1: { type: 'const', value: 'only', meta: { description: 'Only' } },
          2: { type: 'object', dict: { defaultPreset: 1 } },
        },
      },
      value: {},
    } as unknown as SettingsNamespaceView, schema)).toEqual([
      { id: 'only', label: 'Only' },
    ])
  })
})

describe('unwrap', () => {
  it('passes a business success value through', () => {
    expect(unwrap({ ok: true, value: { ok: true, value: { deleted: true } } })).toEqual({ deleted: true })
  })

  it('throws on a transport failure', () => {
    expect(() => unwrap({ ok: false, error: { code: 'internal', message: 'boom', details: {} } }))
      .toThrow('internal: boom')
  })

  it('throws on a business rejection', () => {
    expect(() => unwrap({ ok: true, value: { ok: false, error: { code: 'invalid_name', message: 'blank' } } }))
      .toThrow('invalid_name: blank')
  })
})

describe('messageOf', () => {
  it('reads an Error message', () => {
    expect(messageOf(new Error('boom'))).toBe('boom')
  })

  it('stringifies a non-Error value', () => {
    expect(messageOf('kaboom')).toBe('kaboom')
  })
})

function record(overrides: Partial<ScheduledTaskRecord> = {}): ScheduledTaskRecord {
  return {
    id: 'task-1' as ScheduledTaskRecord['id'],
    name: 'daily',
    prompt: 'run',
    schedule: { kind: 'interval', everySeconds: 3600 },
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    permission: 'workspace-write',
    conversation: { kind: 'new' },
    enabled: true,
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    ...overrides,
  }
}

const GROUPS: ModelProviderGroup[] = [
  { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'Flash' }] },
]

function listOk(items: readonly ScheduledTaskRecord[]): RemoteResult<ScheduledTaskListResult> {
  return { ok: true, value: { ok: true, value: { items } } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

interface RemoteSpies {
  list: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  setEnabled: ReturnType<typeof vi.fn>
  runNow: ReturnType<typeof vi.fn>
}

function makeRemote(overrides: Partial<RemoteSpies> = {}): RemoteSpies {
  return {
    list: vi.fn(async () => listOk([])),
    create: vi.fn(async () => ({ ok: true, value: { ok: true, value: undefined } })),
    update: vi.fn(async () => ({ ok: true, value: { ok: true, value: record() } })),
    delete: vi.fn(async () => ({ ok: true, value: { ok: true, value: { deleted: true } } })),
    setEnabled: vi.fn(async () => ({ ok: true, value: { ok: true, value: record() } })),
    runNow: vi.fn(async () => ({ ok: true, value: { ok: true, value: { sessionId: 's-1' } } })),
    ...overrides,
  }
}

function makeApi() {
  const models = vi.fn(async () => ({ result: { ok: true as const, value: { groups: GROUPS, failures: [] } } }))
  const describe = vi.fn(async () => ({
    result: {
      ok: true as const,
      value: { writable: true, hasDocument: false, namespaces: [permissionView()] },
    },
  }))
  return { api: { llm: { models }, settings: { describe } }, models, describe }
}

function makeStore(remote: RemoteSpies, api = makeApi()) {
  const controller = new ScheduledTaskSettingsStore(
    remote as unknown as ConstructorParameters<typeof ScheduledTaskSettingsStore>[0],
    api.api as unknown as ConstructorParameters<typeof ScheduledTaskSettingsStore>[1],
    schema,
  )
  return { controller, api }
}

describe('ScheduledTaskSettingsStore.load', () => {
  it('loads tasks, model groups, and permission options', async () => {
    const remote = makeRemote({ list: vi.fn(async () => listOk([record()])) })
    const { controller } = makeStore(remote)
    expect(controller.store.getSnapshot().status).toBe('idle')
    await controller.load()
    const snapshot = controller.store.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.tasks.map(task => task.name)).toEqual(['daily'])
    expect(snapshot.modelGroups).toEqual(GROUPS)
    expect(snapshot.permissions).toEqual([
      { id: 'workspace-write', label: 'Workspace write' },
      { id: 'danger-full-access', label: 'Full access' },
    ])
  })

  it('surfaces a whole-load failure without touching the last good data', async () => {
    const remote = makeRemote({ list: vi.fn(async () => listOk([record()])) })
    const { controller } = makeStore(remote)
    await controller.load()
    remote.list.mockRejectedValueOnce(new Error('wire down'))
    await controller.load()
    const snapshot = controller.store.getSnapshot()
    expect(snapshot.status).toBe('error')
    expect(snapshot.error).toBe('wire down')
    expect(snapshot.tasks).toHaveLength(1)
  })

  it('reports a failed model catalog', async () => {
    const remote = makeRemote({ list: vi.fn(async () => listOk([record()])) })
    const api = makeApi()
    api.models.mockResolvedValueOnce({ result: { ok: false, error: { code: 'internal', message: 'catalog down', details: {} } } } as never)
    const { controller } = makeStore(remote, api)
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('error')
    expect(controller.store.getSnapshot().error).toBe('catalog down')
  })

  it('reports a failed settings describe', async () => {
    const remote = makeRemote({ list: vi.fn(async () => listOk([record()])) })
    const api = makeApi()
    api.describe.mockResolvedValueOnce({ result: { ok: false, error: { code: 'internal', message: 'settings down', details: {} } } } as never)
    const { controller } = makeStore(remote, api)
    await controller.load()
    expect(controller.store.getSnapshot().status).toBe('error')
    expect(controller.store.getSnapshot().error).toBe('settings down')
  })

  it('keeps an empty permission list when the namespace is absent', async () => {
    const remote = makeRemote({ list: vi.fn(async () => listOk([record()])) })
    const api = makeApi()
    api.describe.mockResolvedValueOnce({
      result: { ok: true, value: { writable: true, hasDocument: false, namespaces: [] } },
    })
    const { controller } = makeStore(remote, api)
    await controller.load()
    expect(controller.store.getSnapshot().permissions).toEqual([])
  })

  it('ignores a stale successful load', async () => {
    const remote = makeRemote()
    const first = deferred<RemoteResult<ScheduledTaskListResult>>()
    remote.list
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(Promise.resolve(listOk([record({ name: 'fresh' })])))
    const { controller } = makeStore(remote)
    const stale = controller.load()
    await controller.load()
    first.resolve(listOk([record({ name: 'stale' })]))
    await stale
    expect(controller.store.getSnapshot().tasks.map(task => task.name)).toEqual(['fresh'])
  })

  it('ignores a stale failed load', async () => {
    const remote = makeRemote()
    const first = deferred<RemoteResult<ScheduledTaskListResult>>()
    remote.list
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(Promise.resolve(listOk([record()])))
    const { controller } = makeStore(remote)
    const stale = controller.load()
    await controller.load()
    first.reject(new Error('stale boom'))
    await stale
    const snapshot = controller.store.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.error).toBeNull()
  })
})

describe('ScheduledTaskSettingsStore mutations', () => {
  it('creates and reloads', async () => {
    const remote = makeRemote()
    const { controller } = makeStore(remote)
    await controller.create({ name: 'x', prompt: 'p', schedule: { kind: 'interval', everySeconds: 60 }, model: { provider: 'p', model: 'm' }, permission: 'workspace-write', conversation: { kind: 'new' } })
    expect(remote.create).toHaveBeenCalledTimes(1)
    expect(remote.list).toHaveBeenCalledTimes(1)
  })

  it('updates and reloads', async () => {
    const remote = makeRemote()
    const { controller } = makeStore(remote)
    await controller.update({ id: record().id, name: 'x' })
    expect(remote.update).toHaveBeenCalledWith({ id: 'task-1', name: 'x' })
    expect(remote.list).toHaveBeenCalledTimes(1)
  })

  it('removes and reloads', async () => {
    const remote = makeRemote()
    const { controller } = makeStore(remote)
    await controller.remove(record().id)
    expect(remote.delete).toHaveBeenCalledWith({ id: 'task-1' })
    expect(remote.list).toHaveBeenCalledTimes(1)
  })

  it('toggles and reloads', async () => {
    const remote = makeRemote()
    const { controller } = makeStore(remote)
    await controller.setEnabled(record().id, false)
    expect(remote.setEnabled).toHaveBeenCalledWith({ id: 'task-1', enabled: false })
    expect(remote.list).toHaveBeenCalledTimes(1)
  })

  it('runs now and reloads', async () => {
    const remote = makeRemote()
    const { controller } = makeStore(remote)
    await controller.runNow(record().id)
    expect(remote.runNow).toHaveBeenCalledWith({ id: 'task-1' })
    expect(remote.list).toHaveBeenCalledTimes(1)
  })

  it('propagates a rejected mutation without reloading', async () => {
    const remote = makeRemote()
    remote.create.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'refused', details: {} } })
    const { controller } = makeStore(remote)
    await expect(controller.create({} as never)).rejects.toThrow('internal: refused')
    expect(remote.list).not.toHaveBeenCalled()
  })
})
