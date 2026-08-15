# @deepseek-ai/dsh-scheduled-task

[English](README.md) | 中文

`dsh-scheduled-task` 是一个持久化的跨会话调度器。用户定义定时任务——名称、提示词、执行频率规则、运行模型路由、权限预设、对话模式——任务到期时，服务会自动创建（或复用）一个 agent 来运行提示词。任务定义保存在 storage-domain 表中，因此可跨重启存活，且不属于任何单一会话。

## 组合

请在 `ctx.storageDomain`、`ctx.agents`、`ctx.sessions` 之后加载此服务。静态注入会使缺少 storage-domain 表单或 agent 注册表的组合直接失败。`ctx.agentPresets` 与 `ctx.permissionPresets` 为可选，通过全局服务仓库读取；未挂载它们的部署，任务运行在宿主组合上，并使用部署默认的权限旋钮。

服务通过 `ctx.storageDomain` 打开 `scheduled_task` 域，然后启动一个全局调度循环。该循环的每次读取或变更都经过域的内存表，并由存储后端保持持久。

## 持久状态

此包拥有版本 0 的 `scheduled_task` 域：单张 `tasks` 表，以稳定的 `ScheduledTaskId` 为键。每条记录包含已 trim 的 `name`、`prompt`、可区分的 `schedule`（`cron`：`expression` + IANA `timeZone`；或 `interval`：不小于配置下限的正安全整数 `everySeconds`）、`model` 路由（`provider`/`model` 加可选 `reasoningEffort`）、`permission` 预设名、`conversation` 模式（`new`、`task-session`，或带 `sessionId` 的 `session`）、`enabled`，以及创建/更新时间戳。

调度器还会在同一条记录上记录运行状态：`lastRunAt`、最近一次运行使用的 `lastRunSessionId`，以及运行启动失败时的 `lastRunError`。这些是运行路径唯一会写入的字段；域 schema 会在重新打开时校验每一条记录。

## 调度

循环在每次唤醒前读取启用的任务集合。`cron` 规则通过 `croner` 在记录时区中计算下一次匹配；`interval` 规则在最近一次运行后 `everySeconds` 运行。最早未来的时点武装一个分段 timer，每次唤醒都会重新检查墙钟，因此时钟回拨不会提前触发，前跳会把任务标记为到期。到期任务串行运行；失败的运行会记录 `lastRunError` 并推进 `lastRunAt`，使故障任务不会热循环。

## 运行生命周期

一次运行会组合目标 agent：`new` 对话铸造全新会话，`task-session` 在已存在专属会话时复用（首次运行时创建），`session` 对话复用指定会话。每次运行会安装任务固定的模型选择，为新建 agent 挂载默认预设、为复用 agent 挂载其记录的预设，应用任务的权限预设，然后以一条 user 角色消息入队提示词并 flush 会话。

运行确认返回会话 id；提示词的助手输出出现在该会话的普通转录中。启动运行不会等待模型完成。

## Remote API

`ctx.scheduledTasks` 以 Typert Remote 方法暴露 `list`、`create`、`update`、`delete`、`setEnabled`、`runNow`。每个操作返回 `{ ok, value | error }` 联合；拒绝携带稳定错误码（`invalid_name`、`invalid_prompt`、`invalid_schedule`、`invalid_time_zone`、`invalid_model`、`invalid_permission`、`invalid_conversation`、`task_not_found`、`internal`）。生成的 Remote 客户端即 Web UI 的管理面。

## 已知限制与后续工作

- **仅进程内调度** — 任务只在进程存活期间触发；冷启动部署在启动时计算下一个未来运行，不重放错过的积压。
- **固定间隔而非日历规则** — `interval` 以运行时为锚点，不能高于配置下限（默认 60 秒）运行；`cron` 覆盖日历循环。
- **无单次运行回执** — 运行启动以会话 id 确认；模型成功或用户交付不记录在任务记录上。
- **新建运行使用默认预设** — 新建 agent 挂载部署默认预设；暂无按任务的预设选择器。
