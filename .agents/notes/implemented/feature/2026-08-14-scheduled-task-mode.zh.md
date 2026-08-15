# Agent Note: 持久化的跨会话定时任务

Status: implemented

[English](2026-08-14-scheduled-task-mode.md) | 中文

## Problem

[`dsh-schedule`](2026-08-05-durable-web-schedule.md) 提供会话范围内的提醒：一个面向模型的工具把 `schedule/change` 追加到某个 live 会话的日志里，运行时再向同一个会话投递 follow-up，且仅在该会话保持 live 时有效。此前没有一种方式能让部署自身按时间表触发任务——新建一个 agent，或复用一个专属/指定会话——也没有管理这些定义的 Web 界面。

## Decision

`@deepseek-ai/dsh-scheduled-task` 是一个持久化的跨会话调度器。任务定义保存在 `storage-domain` 表里（以带品牌的 `ScheduledTaskId` 为键），因此可跨重启存活，也不属于任何会话。一条记录包含已 trim 的 `name` 与 `prompt`、可区分的 `schedule`（`cron`：表达式 + IANA 时区；或 `interval`：带下限的 `everySeconds`）、`model` 路由、`permission` 预设名、`conversation` 模式（`new`、`task-session`，或带 `sessionId` 的 `session`）、`enabled`，以及运行状态（`lastRunAt`、`lastRunSessionId`、`lastRunError`）。

一个全局调度循环在每次唤醒前重新读取启用的任务集合，并为最早的到期时点武装一个分段 timer。`cron` 规则通过 `croner` 计算下一次匹配；`interval` 规则在最近一次运行后 `everySeconds` 运行。到期任务串行执行；失败的运行记录 `lastRunError` 并推进 `lastRunAt`，使故障任务不会热循环。该循环是进程内的投影——冷启动部署在启动时计算下一个未来运行，不重放错过的积压。

一次运行通过现有的 `ctx.agents.create`/`resume` 边界组合目标 agent：`new` 会话铸造全新 Session，`task-session` 在已存在专属会话时复用它（首次运行时创建），`session` 复用指定会话。每次运行安装任务固定的模型选择，为新建 agent 挂载默认预设、为复用 agent 挂载其记录的预设，应用任务的权限预设，然后以一条 user 角色消息入队提示词并 flush 会话。启动运行不等待模型。

`ctx.scheduledTasks` 以 Typert Remote 方法暴露 `list`、`create`、`update`、`delete`、`setEnabled`、`runNow`，返回 `{ ok, value | error }` 联合。`@deepseek-ai/dsh-client-ui-scheduled-task` 在该 Remote 之上注册一个 `settings.section` 页面，并与其选择器所需的模型目录和权限 Settings 命名空间连接。

## Alternatives considered

- **为 `dsh-schedule` 扩展跨会话模式。** 它的持久状态是所属会话的 `schedule/change` 流，投递契约是会话本地的；跨会话任务需要一份比任何单个会话都长寿的定义，因此独立的 storage-domain 服务比重塑提醒流更干净。
- **像 `dsh-schedule` 那样使用按 agent 的运行时。** 定时任务会启动或复用其自身的 agent，而非挂接到现有 agent 上，因此一个覆盖任务表的全局循环取代了按根 owner 的 timer。

## Consequences

- **仅进程内调度** — 任务只在进程存活期间触发；冷启动计算下一个未来运行并跳过错过的积压。没有外部 cron 或跨进程 ticker。
- **固定间隔而非日历规则** — `interval` 以运行时为锚点并带下限（默认 60 秒）；`cron` 是日历规则。
- **无单次运行回执** — 运行启动以会话 id 确认；模型成功或用户交付不记录在任务记录上。
- **新建运行使用默认预设** — 新建 agent 挂载部署默认预设；暂无按任务的预设选择器。

调度器的进程内特性使其保持为无持久 dispatch 账本的投影，但代价是部署停机期间任务无法触发。
