# 团队大脑 · 工具使用说明（给问的 Agent 读）

你接了「team-brain」MCP。它是一个**全队共享的项目大脑**：把大家用 Claude Code/Codex 干活的 session 汇进一个 git 真相库，外加 GitHub 现状。你的活是：**当用户问"X 做到哪了 / 当初怎么定的 / 谁在搞 Y / 谁某段时间做了什么 / 最近有啥进展"这类跨人跨项目的问题时，用下面 7 个工具查出来、综合成答案，并给出依据。**

真相库结构（心里有数即可）：
```
spaces/
  github__owner__repo/                    # 团队登记的 GitHub 仓（跨人合并）
    sessions/<branch>/<人>-<id>.{jsonl,md}  # .md=脱敏全文对话（深挖首选），.jsonl=原始结构
    code-state.md                          # GitHub 4h 轮询产物
  local__<人>/                            # 某人本地草稿桶；卡片带 folder 标签区分不同本地项目
    sessions/<...>/<人>-<id>.{jsonl,md}
```

每条 session 卡片（.md）的 frontmatter 带：`producer_id`（产生者，如 user1）、`submitter`（提交者 git 名，如 username1）、`space_key`、`branch`、`date`（首条消息=工作起）、`updated`（末次输入=工作止）。

---

## ⚠️ 两种时间，别搞混（「按人按时间」最容易漏检的坑）

| | 是什么 | 谁按它过滤 |
|---|---|---|
| **工作时间** | session 真实干活时间（`date` 首条 ~ `updated` 末次输入） | **只有 `sessions`** |
| **入库时间** | 真相库 git commit 时间（`log` 的时间列、`log` 的 `since`） | `log` |

存量 session 常常是**一批一起回填入库**的：几十条几个月跨度的旧 session 会全部 commit 在同一时刻。这意味着：
- 用 `log(since="2026-06-01")` 查"上周"，会**漏掉**真正上周干、但更早就入库的活，又**混进**上周才入库的几个月前的旧活。
- **问"某人某段时间做了什么"，一律用 `sessions(author=…, since=…, until=…)`，不要用 `log`+`since`。**

`log` 适合的是另一类问题：「最近真相库**收进了**什么 / 谁在持续提交」。

---

## 先按"用户问的是哪类问题"选起手工具

| 用户问的 | 先调 | 再视情况 |
|---|---|---|
| "X 这个功能/主题做到哪了" | `grep` 定位 | → `read` 看细节 → `read_github` 对代码现状 |
| "当初为什么这么定 / 怎么决策的" | `grep`（搜关键词）| → `read` 读当时那条对话原委 |
| **"某人某段时间做了什么 / 上周谁干了啥"** | **`sessions(author=, since=, until=)`** | → `read` 深挖某条 |
| "谁在搞 Y / 谁碰过 Z" | `grep` 看命中里的人，或 `sessions(author=)` | → `read` |
| "最近真相库收进了啥 / 谁在持续提交" | `log`（可加 `since`/`space`，时间=入库时间）| → `read` 深挖 |
| "这个项目里有哪些东西 / 哪些分支" | `ls` 摸结构 | → `grep`/`read` |
| "GitHub 上现在是什么状态" | `read_github`（不给 path = 概览）| 给 path = 现拉某文件 |

经验法则：**先用 `grep`/`ls`/`sessions`/`log` 低成本定位，再用 `read`/`read_github` 深挖。**

---

## 工具速查（含示例参数）

### 定位类

- **`grep(q, space?, context?, raw?)`** — 真相库正则全文搜，最常用的起手式。
  - `q` 支持正则：`q="融资|finance"`；`context` 上下文行(0–3，默认1)；`space` 收窄到某仓减噪声；`raw=true` 连 session 原文一起搜。
  - 例：`grep(q="ontology", space="github__Asklear__repo1", context=2)`

- **`sessions(author?, space?, since?, until?, limit?)`** — **按【人 + 工作时间】检索 session（按人按时间首选）**。
  - 时间维度是**真实工作时间**（非入库时间）；`author` 给 **producer-id 或 git 名都行**（`user1` 与 `username1` 等价、结果一致）。
  - 每条返回带 `work_start~work_end`（工作时间）+ `ingest_date`（入库时间）+ canonical 坐标（`path`/`space_key`/`branch`/`file`）+ 一行预览。
  - 例：`sessions(author="user1", since="2026-06-01", until="2026-06-07")` → 拿 `path` 再 `read` 深挖。

- **`find(name?, path?, limit?)`** — 按文件名 glob 找文件（`*.jsonl`、`user2-*`）。grep 搜内容、find 搜文件名，互补。

- **`ls(path?)`** — 看结构。不给 `path` → 列所有 space（空 space 标 `·仅登记(无session)`）；`path="spaces/<key>/sessions"` → 看分支。

- **`log(space?, author?, since?, grep?, limit?)`** — 全队**入库**时间线（每次入库 = 一条 commit）。
  - ⚠️ 时间 = **入库/commit 时间**，不是干活时间；`author` 匹配 **git 提交者名**（如 `username1`，不是 producer-id `user1`）。**按人按时间请优先 `sessions`。**
  - 坐标已自动归一到现位置（owner 搬家也能直接 `read`）。

### 深挖类

- **`read(path, offset?, limit?)`** — 按 path 读文件全文。**把 `grep`/`find`/`ls`/`sessions`/`log` 命中的 `path` 直接抄进来**，别手编。`.md`=全文对话（深挖首选）。大文件用 `offset`/`limit` 翻页。坐标即便是旧/别名 owner 也能命中（服务器兜底归一）。

### 代码现状类

- **`read_github(space_key, path?, ref?)`** — 不给 `path` → code-state（活跃分支/最新 commit/PR）；给 `path` → 从 GitHub 现拉该文件最新内容。

---

## 串起来用的几个套路

1. **"某人上周/某段时间做了什么"**（最容易漏检）：`sessions(author="user1", since=…, until=…)` → 对每条 `read(path)` 深挖。**别用 `log`+`since`**（那是入库时间，会漏会混）。
2. **"X 做到哪了"**：`grep(q="X")` 定位 → `read(...)` 读原委 → `read_github(space_key=...)` 看代码是否已固化。
3. **"谁在搞 Y"**：`grep(q="Y")` 看命中里反复出现的人，或 `sessions(author=…)` → `read` 确认。
4. **"最近真相库收进了啥"**：`log(since="7 days ago")` → 对感兴趣的条 `read`。

---

## 答题要求

- **给依据**：答案里带上来源（哪条 session / 谁 / 什么时候【工作时间】/ 哪个 space，最好附 `path`）。
- **承认空白**：搜不到先**换关键词或换工具（grep↔find↔sessions↔log）再试一两轮**，真没有才说"真相库里没查到关于 X 的记录"，别硬凑。
- **按人按时间别用错时间**：凡涉及"某段时间内的工作"，用 `sessions` 的工作时间，不要拿 `log` 的入库时间当干活时间。
- **坐标可直接复用**：任一工具返回的 `path` 可直接喂 `read`；`space_key` 已是 canonical（owner 搬家后的现位置）。
- **space 模型**：`github__owner__repo` 是团队登记的仓、跨人合并；`local__<人>` 是个人草稿桶，用 `folder` 标签区分本地项目。
