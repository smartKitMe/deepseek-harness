# Agent Note: Durable cross-session scheduled tasks

Status: implemented

English | [中文](2026-08-14-scheduled-task-mode.zh.md)

## Problem

[`dsh-schedule`](2026-08-05-durable-web-schedule.md) provides session-local reminders: a model-facing tool appends a `schedule/change` to one live Session's log and the runtime delivers a follow-up into that same Session, only while it stays live. There was no way to define a task that the deployment itself fires on a schedule — starting a fresh agent, or resuming a dedicated or named conversation — and no Web surface to manage those definitions.

## Decision

`@deepseek-ai/dsh-scheduled-task` is a durable, cross-session scheduler. Task definitions live in a `storage-domain` table (keyed by a branded `ScheduledTaskId`), so they survive restarts and belong to no Session. One record carries a trimmed `name` and `prompt`, a discriminated `schedule` (`cron` with expression + IANA zone, or `interval` with a minimum `everySeconds`), a `model` route, a `permission` preset name, a `conversation` mode (`new`, `task-session`, or `session` with a `sessionId`), `enabled`, and run state (`lastRunAt`, `lastRunSessionId`, `lastRunError`).

A single global scheduler loop re-reads the enabled set before every wake and arms a bounded timer for the earliest due instant. A `cron` rule computes its next match through `croner`; an `interval` rule runs `everySeconds` after its latest run. Due tasks run serially; a failed run records `lastRunError` and advances `lastRunAt`, so a broken task never hot-loops. The loop is a process-local projection — a cold deployment computes the next future run on startup and does not replay a missed backlog.

A run composes the target agent through the existing `ctx.agents.create`/`resume` boundary: a `new` conversation mints a fresh Session, `task-session` resumes the dedicated Session once one exists (creating it on the first run), and `session` resumes the named Session. Each run installs the task's fixed model selection, mounts the default preset for a fresh agent or the recorded preset for a resumed one, applies the task's permission preset, then queues the prompt as one user-role message and flushes the Session. Starting a run does not await the model.

`ctx.scheduledTasks` exposes `list`, `create`, `update`, `delete`, `setEnabled`, and `runNow` as Typert Remote methods returning `{ ok, value | error }` unions. `@deepseek-ai/dsh-client-ui-scheduled-task` registers one `settings.section` page over that Remote, joined with the model catalog and the permission Settings namespace for its pickers.

## Alternatives considered

- **Extend `dsh-schedule` with a cross-session mode.** Its durable state is the owning Session's `schedule/change` stream and its delivery contract is session-local; a cross-session task needs a definition that outlives any one Session, so a separate storage-domain service was cleaner than widening the reminder stream.
- **A per-agent runtime like `dsh-schedule`'s.** A scheduled task starts or resumes its own agent rather than attaching to an existing one, so one global loop over the task table replaces the per-root-owner timer.

## Consequences

- **In-process scheduling only** — a task fires only while the process is live; a cold start computes the next future run and skips a missed backlog. There is no external cron or cross-process ticker.
- **Fixed intervals, not calendar rules** — `interval` is run-anchored with a minimum (default 60s); `cron` is the calendar rule.
- **No per-run receipt** — a run start is acknowledged by Session id; model success or user delivery is not tracked on the task record.
- **Default preset on fresh runs** — a fresh agent mounts the deployment default preset; there is no per-task preset selector.

The scheduler's in-process nature keeps it a projection with no durable dispatch ledger, but it also means a task cannot fire while the deployment is down.
