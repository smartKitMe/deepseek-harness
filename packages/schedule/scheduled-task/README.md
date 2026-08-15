# @deepseek-ai/dsh-scheduled-task

English | [中文](README.zh.md)

`dsh-scheduled-task` is a durable cross-session scheduler. Users define tasks — a name, prompt, recurrence rule, model route, permission preset, and conversation mode — and the service starts (or resumes) an agent when a task comes due. Task definitions live in a storage-domain table, so they survive restarts and belong to no single session.

## Composition

Load this service after `ctx.storageDomain`, `ctx.agents`, and `ctx.sessions`. Static injection makes a missing storage-domain form or agent registry a composition error. `ctx.agentPresets` and `ctx.permissionPresets` are optional and read through the global service store; a deployment without them runs tasks on the host composition with the deployment's default permission knobs.

The service opens the `scheduled_task` domain through `ctx.storageDomain`, then starts one global scheduler loop. Every read or mutation the loop makes goes through the domain's in-memory table, which the storage backends keep durable.

## Durable state

The package owns the version-0 `scheduled_task` domain: a single `tasks` table keyed by a stable `ScheduledTaskId`. One record carries the trimmed `name`, `prompt`, a discriminated `schedule` (`cron` with `expression` + IANA `timeZone`, or `interval` with a positive safe-integer `everySeconds` at least the configured minimum), the `model` route (`provider`/`model` plus optional `reasoningEffort`), the `permission` preset name, the `conversation` mode (`new`, `task-session`, or `session` with a `sessionId`), an optional absolute `cwd` (absent runs use the host process working directory), `enabled`, and creation/update timestamps.

The scheduler also records run state on the same record: `lastRunAt`, the `lastRunSessionId` the latest run used, and a `lastRunError` when a run failed to start. These are the only fields the run path writes; the domain schema validates every record on reopen.

## Scheduling

The loop reads the enabled task set before every wake. A `cron` rule computes its next match through `croner` in the recorded zone; an `interval` rule runs `everySeconds` after its latest run. The earliest future instant arms a bounded timer, and every wake rechecks the wall clock, so a rollback never fires early and a forward jump marks tasks due. Due tasks run serially; a failed run records `lastRunError` and advances `lastRunAt`, so a broken task never hot-loops.

## Run lifecycle

A run composes the target agent: a `new` conversation mints a fresh session, a `task-session` resumes its dedicated session once one exists (creating it on the first run), and a `session` conversation resumes the named session. Each run installs the task's fixed model selection, mounts the default preset for a fresh agent or the recorded preset for a resumed one, applies the task's permission preset, then queues the prompt as one user-role message and flushes the session. A fresh run's session records the task's `cwd` as its working directory, falling back to the host process working directory when the task leaves it unset.

The run acknowledgement returns the session id; the prompt's assistant output appears in that session's ordinary transcript. Starting a run does not await the model.

## Remote API

`ctx.scheduledTasks` exposes `list`, `create`, `update`, `delete`, `setEnabled`, and `runNow` as Typert Remote methods. Every operation returns a `{ ok, value | error }` union; rejections carry stable codes (`invalid_name`, `invalid_prompt`, `invalid_schedule`, `invalid_time_zone`, `invalid_model`, `invalid_permission`, `invalid_conversation`, `invalid_cwd`, `task_not_found`, `internal`). The generated Remote client is the Web UI's management surface.

## Known Limitations and Deferred Work

- **In-process scheduling only** — a task fires only while the process is live; a cold deployment computes the next future run on startup and does not replay a missed backlog.
- **Fixed intervals, not calendar rules** — `interval` is run-anchored and cannot run more often than the configured minimum (default 60 seconds); `cron` covers calendar recurrence.
- **No per-run receipt** — a run start is acknowledged by session id; model success or user delivery is not tracked on the task record.
- **Default preset on fresh runs** — a fresh agent mounts the deployment's default preset; there is no per-task preset selector.
