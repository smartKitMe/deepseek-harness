// @vitest-environment jsdom
/**
 * ui-scheduled-task browser half on a real cordis Context with fake slots/
 * locale/connection/remote faces: the plugin registers the `settings.section`
 * page with its store inject face, the inject face hands the section the
 * controller + snapshot hook + bound copy, and registration disposal rides
 * the plugin fiber (HMR safety). The node half and the invariant companion
 * are exercised over the same Context.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { ScheduledTaskSection } from '../src/client/ScheduledTaskSection.tsx'
import type { ScheduledTaskSectionInjected } from '../src/client/ScheduledTaskSection.tsx'
import { ScheduledTaskSettingsStore } from '../src/client/store.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

afterEach(cleanup)

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  ctx.provide('connection', {
    api: {
      llm: { models: vi.fn() },
      settings: { describe: vi.fn() },
    },
  } as never)
  // The real Client Remote is a Service; a plain object would bypass the
  // traced `remote.<namespace>` resolution this plugin now injects.
  class RemoteService extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'remote') }
  }
  new RemoteService(ctx)
  ctx.provide('remote.scheduledTasks', {
    list: vi.fn(async () => ({ ok: true, value: { ok: true, value: { items: [] } } })),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    setEnabled: vi.fn(),
    runNow: vi.fn(),
  } as never)

  const slots = ctx.get('slots') as SlotRegistry
  const undeclare = slots.register(
    {
      name: 'root',
      children: {
        'settings.section': { kind: 'list', scope: 'root' },
      },
    } as never,
    () => null,
  )
  const fiber = ctx.plugin({ inject: [...inject], apply })
  return { ctx, slots, locale, undeclare, fiber }
}

function entry(slots: SlotRegistry) {
  return slots.entries('settings.section').find(e => e.component === ScheduledTaskSection)
}

describe('ui-scheduled-task browser plugin', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'remote.scheduledTasks'])
  })

  it('registers the section with its id, order, and inject face', async () => {
    const b = await bench()
    await b.fiber.await()
    b.locale.setLocale('zh')
    const found = entry(b.slots)
    expect(found).toBeDefined()
    expect(found?.options).toMatchObject({ id: 'scheduled-task', order: 40 })
    const face = (found?.inject as unknown as () => ScheduledTaskSectionInjected)()
    expect(face.controller).toBeInstanceOf(ScheduledTaskSettingsStore)
    expect(face.useSnapshot).toBeTypeOf('function')
    expect(face.t).toBeTypeOf('function')
    expect(face.t('nav')).toBe('定时任务')
  })

  it('keeps the nav label following the active locale', async () => {
    const b = await bench()
    await b.fiber.await()
    const found = entry(b.slots)!
    b.locale.setLocale('zh')
    expect(resolveSlotLabel(found.options.label)).toBe('定时任务')
    b.locale.setLocale('en')
    expect(resolveSlotLabel(found.options.label)).toBe('Scheduled tasks')
    b.locale.setLocale('zh')
    expect(resolveSlotLabel(found.options.label)).toBe('定时任务')
  })

  it('drops the section entry when the plugin fiber unloads (HMR safety)', async () => {
    const b = await bench()
    await b.fiber.await()
    expect(entry(b.slots)).toBeDefined()
    await b.fiber.dispose()
    expect(entry(b.slots)).toBeUndefined()
  })

  it('frees the copy namespace on teardown', async () => {
    const b = await bench()
    await b.fiber.await()
    await b.fiber.dispose()
    // The (ns, locale) seats are free again — the dictionary disposer ran.
    expect(() => b.locale.register('settings.scheduled-task', 'zh', {})).not.toThrow()
    expect(() => b.locale.register('settings.scheduled-task', 'en', {})).not.toThrow()
  })
})

describe('ui-scheduled-task node half', () => {
  // The invariant companion is mounted by the vitest-wide invariant host on
  // every Context this suite creates; its registration is covered there.
  it('the node apply is an inert loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
