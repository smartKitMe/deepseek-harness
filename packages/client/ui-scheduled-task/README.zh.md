# @deepseek-ai/dsh-client-ui-scheduled-task

[English](README.md) | 中文

一个用于管理持久定时任务的设置页面。它列出 `dsh-scheduled-task` 服务拥有的任务，并通过生成的 Remote 编辑它们：名称、提示词、cron 或固定间隔的执行频率、运行模型、权限预设、对话模式（每次新建会话、任务专属会话，或复用指定会话），以及可选的工作目录绝对路径（留空使用宿主默认目录）。每一行还可以立即运行、启用/停用或删除任务。

## 组合

此包注册一个 `settings.section` 条目（`id: scheduled-task`）。其浏览器半边需要 `slots`、`locale`、`connection`、`remote` 以及 `remote.scheduledTasks` 命名空间；该命名空间由 `dsh-api-remotes` 客户端装配挂载。node 半边是空 apply —— 插件存在于宿主图中，这样它的 `dsh.client` 行就能被扫描进浏览器清单。

## Model Experience

间接影响 —— 此界面从不向模型发送内容。它写入的任务只有通过 scheduled-task 服务自身的运行路径才会对模型可见，其框架说明见该包的 README。

#### KV Cache effect

无直接失效。

## 已知限制与后续工作

- **单一平铺表单** — 编辑器是一个创建/编辑界面，除保存门槛外没有逐字段校验反馈；宿主校验错误以单行失败显示。
- **无会话选择器** — `复用指定会话` 模式接受原始会话 id，而非可浏览的会话列表。
- **无频率预览** — 保存前不会把 cron 表达式展开为接下来几次运行时间。
