# @deepseek-ai/dsh-client-ui-scheduled-task

English | [中文](README.zh.md)

A settings section for managing durable scheduled tasks. It lists the tasks the `dsh-scheduled-task` service owns and edits them through the generated Remote: name, prompt, cron or fixed-interval recurrence, model route, permission preset, conversation mode (new session, task-dedicated session, or a specific session), and an optional absolute working directory (blank uses the host default). Each row also runs a task immediately, toggles it on or off, or deletes it.

## Composition

This package registers one `settings.section` entry (`id: scheduled-task`). Its browser half requires `slots`, `locale`, `connection`, `remote`, and the `remote.scheduledTasks` namespace; the namespace is mounted by the `dsh-api-remotes` client assembly. The node half is an empty apply — the plugin exists in the host graph so its `dsh.client` row can be scanned into the browser roster.

## Model Experience

Indirectly — this surface never sends content to the model. The tasks it writes become model-visible only through the scheduled-task service's own run path, whose framing is documented in that package's README.

#### KV Cache effect

No direct invalidation.

## Known Limitations and Deferred Work

- **Single flat form** — the editor is one create/edit surface without per-field validation feedback beyond the save gate; host validation errors surface as a single failure line.
- **No session picker** — the `reuse a specific session` mode takes a raw session id, not a browsable session list.
- **No schedule preview** — cron expressions are not expanded into the next few run times before saving.
