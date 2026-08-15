/**
 * One scheduled-task run: compose and start (or resume) an agent, apply the
 * task's model, permission, and preset, and enqueue the prompt.
 * @module @deepseek-ai/dsh-scheduled-task
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentSetup } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type { ScheduledTaskRecord } from './types.ts'

/** Fresh session prefix for a `new` or first `task-session` run. */
const SCHEDULED_SESSION_PREFIX = 'scheduled-'

/** Stable plugin source recorded on the injected prompt message. */
export const SCHEDULED_TASK_SOURCE = 'scheduled-task'

/** Outcome of one run attempt, surfaced through the service for durable bookkeeping. */
export interface ScheduledTaskRunOutcome {
  /** Session the run used (created or resumed). */
  readonly sessionId: SessionId
}

/**
 * Build the Agent setup for one run: install the fixed model selection, then
 * mount the preset this run composes from (default for a fresh agent, the
 * recorded preset for a resumed one).
 * @param ctx - host context carrying the optional preset roster.
 * @param selection - fixed model selection for the run.
 * @param presetId - preset id to mount, or `undefined` for the default/absent roster.
 * @returns the pre-publication setup callback.
 */
function composeSetup(ctx: Context, selection: ModelSelection, presetId: string | undefined): AgentSetup {
  const presets = ctx.get('agentPresets')
  return async (agentCtx: Context) => {
    installModelSelection(agentCtx, { current: selection, assembled: undefined })
    if (presets === undefined) return
    await presets.mount(agentCtx, presetId)
  }
}

/**
 * Resolve the preset a resumed session records, so its history replays under
 * the composition that produced it.
 * @param ctx - host context carrying session persistence.
 * @param sessionId - persisted session to resume.
 * @returns the recorded preset id, or `undefined`.
 */
async function resumedPreset(ctx: Context, sessionId: SessionId): Promise<string | undefined> {
  const presets = ctx.get('agentPresets')
  const persistence = ctx.get('sessionPersistence')
  if (presets === undefined || persistence === undefined) return undefined
  const inspected = await persistence.inspect(sessionId)
  return resolveSessionPreset({ header: inspected.meta, events: inspected.events })
}

/**
 * Start one run of a scheduled task: create or resume the agent under the
 * task's model and preset, apply its permission preset, and enqueue the prompt.
 *
 * The caller owns the agent lifecycle; this function returns once the prompt
 * is queued, not when the model finishes.
 * @param ctx - host context carrying agents, sessions, presets, and permissions.
 * @param record - the durable task definition to run.
 * @returns the run acknowledgement carrying the session used.
 */
export async function runScheduledTask(
  ctx: Context,
  record: ScheduledTaskRecord,
): Promise<ScheduledTaskRunOutcome> {
  const agents = ctx.agents
  const selection: ModelSelection = {
    provider: record.model.provider,
    model: record.model.model,
    ...record.model.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(record.model.reasoningEffort) },
  }

  const resumeTarget = record.conversation.kind === 'session'
    ? record.conversation.sessionId
    : record.conversation.kind === 'task-session' && record.lastRunSessionId !== undefined
      ? record.lastRunSessionId
      : undefined

  let agent: Agent
  if (resumeTarget !== undefined) {
    const presetId = await resumedPreset(ctx, resumeTarget)
    const handle = await agents.resume({
      resumeSessionId: resumeTarget,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: composeSetup(ctx, selection, presetId),
    })
    agent = handle.agent
  } else {
    const sessionId = SessionId(`${SCHEDULED_SESSION_PREFIX}${randomUUID()}`)
    const presets = ctx.get('agentPresets')
    let presetId: string | undefined
    if (presets !== undefined) presetId = (await presets.resolve(undefined)).id
    const handle = await agents.create({
      sessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
      meta: {
        cwd: record.cwd ?? process.cwd(),
        ...presetId === undefined ? {} : { agentPreset: presetId },
      },
      setup: composeSetup(ctx, selection, presetId),
    })
    agent = handle.agent
  }

  // Apply the task's permission preset before the first turn assembles, so the
  // run executes under the configured sandbox/approval knobs.
  const permissionPresets = ctx.get('permissionPresets')
  if (permissionPresets !== undefined) {
    permissionPresets.set(agent.session, record.permission)
  }

  const message = createUserMessage({
    content: [{ type: 'text', text: record.prompt }],
    source: { kind: 'plugin', plugin: SCHEDULED_TASK_SOURCE },
  })
  agent.followup(message)
  await ctx.sessions.flush(agent.session)

  return { sessionId: agent.id }
}
