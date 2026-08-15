import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import ScheduledTaskService from '../src/index.ts'

let root: string | undefined
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(configPath: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root as string).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-scheduled-task', ScheduledTaskService],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  const unloaded = [...ctx.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])
  return ctx
}

describe('scheduled-task service through a real Loader composition', () => {
  it('exposes the Remote methods and persists CRUD across a cold restart', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduled-task-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '  config:',
      `    root: ${JSON.stringify(join(root, 'sessions'))}`,
      '    compression: none',
      '    writeBatchMaxDelayMs: 1',
      "- name: '@deepseek-ai/dsh-storage'",
      "- name: '@deepseek-ai/dsh-storage-json'",
      '  config:',
      `    root: ${JSON.stringify(join(root, 'storage'))}`,
      "- name: '@deepseek-ai/dsh-storage-domain'",
      '  config:',
      '    backend: json',
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-scheduled-task'",
      '',
    ].join('\n'))

    const first = await loadComposition(configPath)
    expect(first.scheduledTasks.typertRemote.namespace).toBe('scheduledTasks')
    expect(remoteMethods(first.scheduledTasks).map(marker => marker.method))
      .toEqual(['list', 'create', 'update', 'delete', 'setEnabled', 'runNow'])

    const create = await first.scheduledTasks.create({
      name: 'daily report',
      prompt: 'summarize the logs',
      schedule: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' },
      model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      permission: 'workspace-write',
      conversation: { kind: 'new' },
    })
    if (!create.ok) throw new Error(`expected create success, got ${create.error.code}`)
    expect(create.value).toMatchObject({ name: 'daily report', enabled: true })
    expect(create.value.conversation).toEqual({ kind: 'new' })

    const list = first.scheduledTasks.list()
    if (!list.ok) throw new Error(`expected list success, got ${list.error.code}`)
    expect(list.value.items).toHaveLength(1)
    expect(list.value.items[0]?.id).toBe(create.value.id)

    const disabled = await first.scheduledTasks.setEnabled({ id: create.value.id, enabled: false })
    if (!disabled.ok) throw new Error(`expected setEnabled success, got ${disabled.error.code}`)
    expect(disabled.value.enabled).toBe(false)

    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    const second = await loadComposition(configPath)
    const relisted = second.scheduledTasks.list()
    if (!relisted.ok) throw new Error(`expected relist success, got ${relisted.error.code}`)
    expect(relisted.value.items).toHaveLength(1)
    expect(relisted.value.items[0]?.enabled).toBe(false)

    const removed = await second.scheduledTasks.delete({ id: create.value.id })
    if (!removed.ok) throw new Error(`expected delete success, got ${removed.error.code}`)
    expect(removed.value).toEqual({ deleted: true })

    const empty = second.scheduledTasks.list()
    if (!empty.ok) throw new Error(`expected empty list success, got ${empty.error.code}`)
    expect(empty.value.items).toHaveLength(0)
  })

  it('rejects invalid create input with a stable business code', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduled-task-invalid-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-storage'",
      "- name: '@deepseek-ai/dsh-storage-json'",
      '  config:',
      `    root: ${JSON.stringify(join(root, 'storage'))}`,
      "- name: '@deepseek-ai/dsh-storage-domain'",
      '  config:',
      '    backend: json',
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-scheduled-task'",
      '',
    ].join('\n'))

    const ctx = await loadComposition(configPath)
    const create = await ctx.scheduledTasks.create({
      name: '   ',
      prompt: 'run',
      schedule: { kind: 'interval', everySeconds: 60 },
      model: { provider: 'p', model: 'm' },
      permission: 'workspace-write',
      conversation: { kind: 'new' },
    })
    expect(create).toEqual({
      ok: false,
      error: { code: 'invalid_name', message: 'task name must not be blank.' },
    })
  })
})
