# dsh-session-delete

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）Web GUI 加一个**会话回收站**：删除的会话先进回收站、保留 3 天，期间可以恢复，也可以立刻永久清除。

DSH 原生侧栏对会话只有「归档」，没有删除；会话日志会一直堆在 `~/.dsh/sessions/` 里。这个插件补上删除，并且是**可逆的删除**：

- 会话菜单底部多一行红色「删除会话」；
- 侧栏底部（设置按钮旁）多一个回收站入口，带待清理数量角标；
- 删除 = 移入回收站（不是硬删）；
- 回收站里可以「恢复」「立即清除」「清空」；
- 到期（默认 3 天）自动清除。

## 功能

| 位置 | 行为 |
|---|---|
| 会话「…」菜单 → 删除会话 | 确认后移入回收站：日志移出持久化根，侧栏立即不再显示 |
| 侧栏底部 → 回收站 | 列出待处理会话：标题、删除时间、剩余天数 |
| 回收站 → 恢复 | 日志搬回原路径 + 取消归档 → 回到原工作区原位置（原置顶的恢复置顶） |
| 回收站 → 立即清除 | 二次确认后永久删除该条 |
| 回收站 → 清空回收站 | 二次确认后清空全部 |
| 到期清扫 | 插件启动时、每 30 分钟、每次打开回收站前各扫一次 |

界面文案支持中文 / English / 日本語（跟随 DSH 语言设置）。

## 安装

插件是一个普通的 DSH bundle（`package.json` 里声明 `dsh.bundle.patch` 与 `dsh.client`）。

从 GitHub 装：

```bash
dsh plugin --profile web add github:Zyl20030506/dsh-session-delete
```

装完重启 DSH（客户端插件代码缓存在页面里）。卸载：`dsh plugin --profile web remove dsh-session-delete`。

从本机目录装（改代码时用，走 `link:`，改完刷新页面即生效）：

```text
plugin_manager  action: install_bundle  target: <本目录的绝对路径>
```

> 包名 `dsh-session-delete` 出现在三处，改名必须一起改：`package.json` 的 `name`、`client.js` 里 `_ModuleLoader__.load({ id })` 的 id、`cordis.patch.yml` 里的 `name`。profile 里的 bundle 名和依赖键由安装器按包名写入，不要手改。

## 配置

保留期与清扫间隔可调。在 profile 的 bundle 配置里写：

```yaml
- id: session-delete
  name: 'dsh-session-delete'
  config:
    retentionDays: 7    # 默认 3
    sweepMinutes: 60    # 默认 30
```

不想有任何自动删除，把 `retentionDays` 调大（例如 `3650`），只用手动「立即清除」。

## 工作原理

两个 Host 路由（`ctx.connection.fetch.register`，受 DSH 浏览器鉴权保护）：

```text
POST /api/plugin.session-delete   { sessionId, title }             → 移入回收站
POST /api/plugin.session-trash    { action, sessionId?, payload? } → list | restore | purge | empty
```

回收站是磁盘上一个独立目录，**在持久化根之外**，所以搬进去的会话立刻从「会话列表 / 侧栏 / 搜索索引」里消失，而不是靠标记隐藏：

```text
<DSH_HOME>/session-trash/v1/<sessionId>/
  meta.json                      # 标题、删除时间、到期时间、原始绝对路径、原工作区、原位置邻居、是否置顶
  data/session.v4.jsonl.zstd     # 从 <DSH_HOME>/sessions/<项目>/<sessionId>/ 整体搬来的日志
```

删除流程（每一步都可回滚）：

1. 先问 `workspace/session-activity` 瀑布：有正在运行的回合 / 子任务 / 后台任务 / 定时提醒就拒绝，并把类型告诉用户；
2. 写 `meta.json`（`state: moving`）——先落盘，中途崩溃也还能从回收站恢复；
3. 用 DSH 的**归档**机制隐藏该会话；
4. 把日志文件逐个 `rename` 进 `data/`，目录空了就删掉；
5. `meta.json` 标记 `state: ready`，删掉 `session_projcache` 里对应的投影缓存。

任何一步失败：文件搬回、取消归档、删除条目，原状态不变。

**为什么用「归档」来隐藏**：DSH 的会话清单是 live-preferred 的——只要某个会话的 Agent 还在内存里，它就会被列出来。早先的实现用「从工作区账目摘除」来隐藏，摘掉的 id 会掉进侧栏的「未分组」里。改用归档后，行的隐藏与「是否还被列出」无关，而且账目和位置都保留，恢复时不需要重新挂载。

| 操作 | 归档标记 | 日志位置 | 到期自动删 |
|---|---|---|---|
| 原生「归档会话」 | 设置 | 原地不动 | **不会** |
| 本插件「删除会话」 | 设置（作为隐藏手段） | 移入回收站 | 会 |

## 安全边界

- **只拒绝真正在跑的会话**：依据 DSH 自己的活动瀑布（`turn` / `subagent` / `job` / `schedule`），不拿「进程里有没有 Agent」当判据——空闲但驻留的 Agent 不阻塞删除。
- **拒绝删除当前主视图正在显示的会话**（客户端判断 `retainedBy.mainView`），否则那个视图会继续往已移走的日志里写。
- **日志文件被占用时不硬来**：`rename` 遇到 `EPERM/EBUSY/EACCES` 会转成明确提示，并回滚已移动的文件。
- **只动会话自己的文件**：目录里出现非会话日志的文件时，只移动日志文件，目录与外来文件都保留；恢复时原样放回旁边。
- **清单读不出来就不动**：`meta.json` 缺失或损坏的条目既不会自动删，也不会被猜着恢复。

## 兼容性（DSH 升级会不会让它失效）

会，取决于碰到哪一层。插件依赖分三档：

| 档位 | 依赖 | 失效表现 |
|---|---|---|
| 稳（DSH 的正式扩展点） | `/api` Fetch 路由、`sessionPersistence.stat()` 的 `location.path`、`workspaceRegistry.archiveSession/unarchiveSession/pinSession/list`、`contextMenu.icon` / `sidebar.footer.action` / `shell.overlay` 三个 slot、bundle patch 格式 | 基本不会变 |
| 可能漂移 | `contextMenus.register` 的动作字段（`danger` / `afterContent`）、`sessions.refresh()`、`Workspace.attachSession/insertSessionBefore/detachSession`、投影缓存路径 `storages/session_projcache/sessions/<id>.json` | 菜单项不出现 / 列表不刷新 / 清缓存落空（只留几 KB 垃圾） |
| 最脆 | 冷启动时服务就绪顺序、`workspace/session-activity` 的事件名与分类 | 以前踩过：菜单项静默消失、误判"窗口打开着" |

为了不在升级后"静默坏掉"，插件内置了四道自适应：

1. **能力自检**：每次删除前确认 `sessionPersistence.stat`、`workspaceRegistry.archiveSession/unarchiveSession/list`、`events.waterfall` 都在。缺一个就**拒绝删除**（返回 `incompatible` 并列出缺什么），不会出现"文件搬走了、侧栏还留着"的半成品。回收站弹窗顶部也会提示当前缺少的能力。
2. **活动判断双保险**：同时看 `workspace/session-activity` 瀑布（`turn`/`subagent`/`job`/`schedule`）和 Agent 自己的 `status === 'running'`。任一说在跑就拒绝——即使活动事件的 provider 以后改名，也不会退化成"允许删除运行中的会话"。
3. **注册隔离**：菜单项、回收站按钮、两个弹窗各自独立注册，单个扩展点失败只在控制台留一行 `[session-delete] … failed`，其余功能照常，不会整插件消失。
4. **数据格式自带版本**：回收站清单 `meta.json` 有 `version`，旧条目不会被新版本误读；日志路径来自后端而不是硬编码；任何一步失败都回滚。

失败时怎么排查：打开 DevTools 控制台搜 `session-delete`；回收站弹窗顶部会显示"当前 DSH 缺少本插件需要的能力：…"；`workspace.json` 里的归档标记与 `session-trash/v1/*/meta.json` 都是可读的纯 JSON。

## 已知限制

- **不删会话之外的内容**：用户上传的图片/文件（`~/.dsh/attachments`，按内容哈希多处共享）、溢出的临时大结果（`%TEMP%\dsh-spill-*`）、以及会话在工作区里产出的文件都不在回收站范围内。
- **「显示已归档」筛选里可能看到回收站会话**：它们的 Agent 还驻留时会被会话清单列出。点它会提示「已归档的会话无法打开」。彻底清除或 Agent 释放后就不再出现。
- **不要用原生的「取消归档」来恢复回收站里的会话**：那只把行放回来，日志还在回收站里。请用回收站的「恢复」。
- **无法关闭驻留的空闲 Agent**：DSH 只允许创建它的 `AgentHandle` 释放。插件因此选择「先归档隐藏 + 移动文件」，依靠活动检查与文件占用错误兜底。
- **平台**：Windows 上完整验证；POSIX 依赖同一卷内的 `rename`（回收站与 `sessions/` 同在 `DSH_HOME` 下）。

## 测试

无依赖，Node ≥ 22 直接跑：

```bash
npm test     # 等价于 node test/trash.test.mjs
```

测试用临时目录 + 伪造的 Cordis 服务驱动真实 Host 逻辑，覆盖 18 个用例：入站（归档隐藏 / 搬文件 / 清缓存）、列表、恢复（原位、外来文件共存、旧清单重建账目）、单个清除、清空、到期清扫、归档条目保留墓碑、孤儿墓碑清理、活动会话拒绝（含类型与仅靠 `status` 的判定）、活但空闲可删、活动探测不可用时的保守回退、归档准入拒绝时不动文件、缺少能力时拒绝删除、未落盘会话。

## 目录结构

```text
.
├── package.json          # bundle 清单：dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # 插入 session-delete 行
├── index.js              # Host 半：两条路由、回收站、清扫、归档隐藏
├── client.js             # 浏览器半：菜单项、回收站按钮、两个弹窗（纯 React + 主题 token）
├── locale/{en,zh}.json   # 插件管理器里的标题与描述
├── icon.svg              # 插件图标
└── test/trash.test.mjs   # Host 逻辑用例
```

## English quickstart

A recycle bin for DeepSeek Harness sessions. Deleting a session moves its log out of the persistence root into `<DSH_HOME>/session-trash/v1/<id>/` (with a `meta.json`), hides the row through DSH's archive set, and keeps it restorable for `retentionDays` (default 3) before the sweep removes it for good.

Install with `plugin_manager action: install_bundle target: <this directory>`, then reload the page. Config: `retentionDays`, `sweepMinutes`. Run `npm test` for the 18-case Host suite. Sessions with running work are refused (activity waterfall); idle-but-resident agents do not block. Attachments, spill files and workspace output are intentionally left alone.

## License

MIT — see [LICENSE](LICENSE).
