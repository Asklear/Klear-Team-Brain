# Klear-Team-Brain

> **全队 AI 编程的共享记忆。**
>
> 大家照常用 Claude Code / Codex 干活，session 自动汇进一个共享的 **git 真相库**，并与 GitHub 代码现状、团队文档融为一体。任何人都能在编辑器里通过 MCP 问一句「X 做到哪了 / 当初怎么定的 / 谁在搞 Y」，拿到综合全队 **session + 代码 + 文档** 的答复。自托管、带隐私闸门、对干活的人零额外负担。

[English](./README.md) | 中文

> **状态：** 早期、自托管、单租户。你自己跑服务器，数据不出你的基础设施。见 [自托管部署](./DEPLOY.md)。

---

## 为什么

目标、进展、思考本来散在各人脑子、文档、代码、一关就没的对话里。Klear-Team-Brain 把它们汇到一处、可被随时检索与综合 —— 让认知不再必须经过某一个人来路由。

## 核心模型

**只固定「真相」，「视图」一概可弃。**

- **真相层（substrate）** ＝ 几类原料（session / 文档 / 代码状态）+ 元数据（谁 / 类型 / repo / branch / 时间）。唯一要认真存、保持干净完整的东西 —— 因为真相贵且不可重建，视图便宜可重建。底层是一个 **git 仓**。
  - session 以**蒸馏**形态存（`core/slim.mjs`）：剥掉内联图片 base64、截断巨型 tool 输出，存的是信号不是字节；字节精确的原文留在产出者本机（`~/.codex` / `~/.claude`）。
- **视图层（理解）** ＝ 对真相的一个索引/查询。形态自由、可换、可丢。现在 ＝ 问 Agent 现查现答。

一个闭环，不是两件事：

```
   产生（干活） ───▶ 沉淀 ───▶ 理解（消费）
   CC/Codex 写代码      收进 git 真相库      问 Agent（MCP）
   /文档/调研          每条带 谁·repo·branch·时间   「X 做到哪了」
        ▲                                              │
        └──────────── 理解又让下一步干得更准 ────────────┘
```

**每种东西长在哪、就从哪收**（这就是融合依据）：

| 维度 | 主要长在 | 在真相库里 |
|---|---|---|
| **进展 · 思考** | CC/Codex session | `sessions/<branch>/`（瘦身 jsonl + 脱敏全文 transcript md）|
| **代码进展** | GitHub | 不存本体，查询时现拉 + 4h 轮询出 `code-state.md` |
| **目标 · 决策（人写）** | 团队文档（Lark/飞书 wiki） | `feishu/<知识库>/…`：正文单向镜像，grep/read 可搜可读；要改去源文档 |

## 数据流

```
每台机器（客户端）                          你的服务器（自托管）
┌────────────────────────┐            ┌──────────────────────────────────┐
│ 采集器 client/sync       │  gzip+token │ server/server.mjs（HTTP，反代如    │
│  常驻，盯 jsonl           │ ──────────▶ │  Caddy 套 HTTPS）                  │
│  按 upload_folders 闸门   │            │  /ingest → git 真相库 TRUTH_DIR    │
│                          │            │   spaces/github__o__r | local__人  │
│ 问 Agent  mcp/server      │  搜+拉,综合 │  /grep /find /read /ls /log /github│
│  在 CC/Codex 里问一句     │ ◀────────── │  + 每 4h 拉 GitHub 出 code-state   │
└────────────────────────┘            └──────────────────────────────────┘
```

干活的人**啥都不做，活就进了大脑**；想了解的人**问一句**就拿到综合答复。

## 快速开始

**前置：** Node 22+；以及至少一个支持 MCP 的编辑器/CLI（Claude Code 或 Codex）用来提问。

1. **起一台服务器**（一台小 VPS）。见 [DEPLOY.md](./DEPLOY.md)：装 Node、clone、设 `TRUTH_DIR`、配花名册 + token、前面套 HTTPS、跑成常驻服务。
2. **接入客户端** —— 指向你的服务器并加入：
   ```bash
   curl -fsSL https://your-server.example.com/get | bash   # 下载客户端 + 注册 brain 命令
   brain join <你的邀请码>                                   # 校验 + 选工作空间 + 接 MCP + 首同步 + 装常驻
   ```
3. **在编辑器里问。** 接好 MCP 后，在 CC / Codex 里直接问：「鉴权重构做到哪了？」「谁在搞计费？」「schema 当初怎么定的？」

## 怎么问（MCP 工具）

真相库被当成一个**只读文件夹**暴露给提问的 Agent，由几个 Unix 式原语串起来，统一用真相库相对 `path`：

| 工具 | 干啥 |
|---|---|
| `grep` | 搜内容（git grep 正则全文）。默认搜 `.md`（脱敏 transcript）；`raw=true` 连 `.jsonl`。 |
| `find` | 按文件名/glob 找文件。（grep 搜内容、find 搜文件名，互补。）|
| `read` | 按 path 读任意文件（大文件用 offset/limit 翻页）。|
| `ls` | 看结构：有哪些 space、分支、几条 session。|
| `log` | 活动时间线（真相库 git 历史；可按 space/author/since 收窄）。|
| `read_github` | 出网现拉某仓代码状态或文件最新内容（代码本体不入库）。|

服务器侧查询走 `git grep` / `git ls-files` / `git log` / `fs` —— **execFile 无 shell、锁死 `TRUTH_DIR` 内、只读** —— Agent 像翻本地目录一样定位/读/摸结构，零服务器 LLM。

**接别的编辑器：** MCP 是个 stdio server，命令固定为 `<node> <安装目录>/mcp/server.mjs`（`brain mcp` 会打印你这台的实际路径）。在 Claude Code、Codex 或任何支持 MCP 的客户端（Gemini CLI / Cursor / Cline / opencode…）里加一个 stdio MCP server 即可。

## 隐私与安全

- **范围闸门：** 只有 session 的 cwd 在你本机 `upload_folders` 白名单内才上传 —— 圈内默认共享、圈外默认私有。
- **脱敏：** 派生的 `.md` transcript 在服务器投影时过脱敏（密钥/token + 家目录路径），`/read` 出口再兜底一次。
- **token / PAT：** 成员 token、GitHub PAT、文档源凭证都住服务器、都 gitignore；花名册（不含密钥）可提交。
- **真相库就是全部价值 —— 别 push 到任何公开 remote，并定期备份。** 自托管在只对圈内开放的基础设施上。

## 非目标

它汇聚并帮你理解 CC/Codex session + GitHub + 文档里的东西。它**不是** IM / 项目管理 / 代码托管，也不取代它们。

## 参与贡献

欢迎 Issue 和 PR —— 见 [CONTRIBUTING.md](./CONTRIBUTING.md) 与 [SECURITY.md](./SECURITY.md)。本项目内部开发、镜像到此；外部贡献经 review 合入上游后再流出。

## 许可

[Apache-2.0](./LICENSE) © Asklear
