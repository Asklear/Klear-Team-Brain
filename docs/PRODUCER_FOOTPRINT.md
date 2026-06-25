# 生产者足迹 / 上传前预览 / 按条 opt-out 设计

> 目标：降低被动入库者的「被监视感」，让全员愿意开。
> 分支：`feat-producer-footprint`

## 1. 为什么做这个

team-brain 的价值靠**全员开**才成立——一个人不开，他参与的跨人项目就有黑洞。
但「我干活的全文对话被持续上传、队友随时能 grep」天然让人不安。现状的安全感
全压在**安装时**那一道闸（`upload_folders` 白名单 / `exclude` 黑名单 / `collect_all` 警告），
开了之后就是个**黑盒**：

- 我**不知道**我哪些 session 真进了库（`brain status` 只给最近一条 tick 的计数）。
- 我**看不到**脱敏后长啥样——只能信「客户端会脱敏」，但 `redact.mjs` 自己注明
  *内容级脱敏（客户名等）尚未做*。
- 我想撤一条**做不到**：opt-out 只有文件夹级（`exclude`），没有「就这一条别传」。

把黑盒变成**可见 + 可控**，是这版要解决的。

## 2. 关键现状（决定哪些便宜、哪些贵）

调研后三条结论直接决定方案形状（证据见 `client/sync.mjs`、`core/`、`server/`）：

| 结论 | 证据 | 对设计的影响 |
|---|---|---|
| **预览几乎免费** | `core/redact.mjs` / `core/project.mjs`(`projectSession=redactAgent(transcript)`) / `core/slim.mjs` 全是**确定性、无副作用**函数，且 `core/` **本就随客户端下发**（`client.tgz`=core/client/mcp/cli）。 | 客户端能本地跑 `projectSession(slimRaw(raw), tool)` 复现**与服务端一字不差**的 `.md` 正文。**零服务端改动**。 |
| **足迹主要是接线** | 服务端已有 `/whoami`（token→自己 id）+ `/sessions?author=`（按人列 session）。 | 「库里到底有我哪些」是一次查询。缺口仅在客户端：`.brain-state.json` 把**上传**和**跳过**标成一样（到处 `seenSession.set(file,m)`），丢掉了「传没传/为啥」。 |
| **按条 opt-out 是新东西，且便宜的一半在上传前** | 无任何 DELETE/retract 端点；`admin remove` 只撤 token、**保留全部历史**。脱敏/闸门均在上传前（`sync.mjs:166/204/389`）。 | 「这条永不上传」= 纯客户端新增。「撤一条已传的」= 新服务端端点 + git 语义，明显更贵、且涉及 git 历史。 |

## 3. 设计原则

1. **信任的最强杠杆是「上传前的本地控制」**——东西没离开机器，焦虑最小。
   优先做 client 侧、CLI（`brain` 是本地、已有的唯一触点）。Web 是协作/共享面、
   且**没有 per-viewer 身份**（任何 token 能读任何人），放后面。
2. **先可见，再可控**：透明本身就降焦虑且零风险（不改上传行为）。
3. **不改默认契约**：保持「默认上传 + opt-out」的现有气质，opt-out 是**加法**；
   是否引入「先审后传」作为 opt-in 单独决策（见 §7）。
4. **真相库幂等、git 可追溯**：retract 要诚实标注「git 历史里仍可考古，除非额外重写历史」。

## 4. 三件事的具体方案

### 4.0 地基：把「结果」记下来（`outcome ledger`）
现状 daemon 处理完每个文件就 `seenSession.set(file, m)`，无论是**上传成功**、
**闸门外跳过**、**太大跳过**、**无 intent 跳过**——信息全丢。

改动：在 `.brain-state.json` 旁加一份**结果账本**（或把 `session` 值从 `mtime`
升级成 `{mtime, status, ...}`，向后兼容旧格式）。每条记：

```
{ file, id, tool, status, space_key?, branch?, intent, bytes_raw, bytes_slim, ts }
status ∈ uploaded | skipped_gated | skipped_excluded | skipped_toobig
       | skipped_nointent | skipped_subagent | opted_out
```

这是**一切的地基**且纯客户端：`brain mine` 靠它离线回答「传了啥 / 没传啥 / 为啥」。
落点：`client/sync.mjs`（4 个 sync* 函数的标记点）+ 一个小 `core/ledger.mjs`。

### 4.1 我的足迹 —— `brain mine`（别名 `brain footprint`）
**本地视角（默认，离线）**：读结果账本，分组列出
```
$ brain mine
本机最近 50 条 session：
  ✓ 已传  12   ⤫ 闸门外 30   ⛔ 已排除 3   🚫 我手动排除 2   ⚠ 跳过(大/空) 1

✓ github__Asklear__bossa / main
   tqt-...901a  "理解 staff bot 任务管理…"   2026-06-24  →库
   ...
⤫ 闸门外（留本机，没传）
   ~/Code/private-x  "改个支付密钥…"   （不在 upload_folders）
```
每行可接动作：`brain preview <id>` / `brain optout <id>`。

**库内视角（`--remote`，对账）**：`/whoami` → `/sessions?author=me`，列**库里实际有的**。
用途：抓「别的机器传的」「以为撤了其实还在」。本地账本 ⨯ 库内清单的差集 = 惊喜来源。

### 4.2 上传前预览 —— `brain preview <id|file|latest>`
因为脱敏+渲染都在 `core/` 且确定性，客户端**本地**算出与库里一字不差的正文：
```js
import { slimRaw } from "../core/slim.mjs";
import { projectSession } from "../core/project.mjs";
const slim = slimRaw(readFileSync(file, "utf8"));   // = 上传体
const body = projectSession(slim, tool);            // = 服务端 .md 正文（脱敏后）
```
输出：
- **队友会看到的正文**（脱敏后 transcript），
- 会落到哪个坐标（space/branch，由 `coordOf` + 现状闸门判定），
- **被剥/被抹了什么**的提示（图片/大输出截断、命中的脱敏规则计数），
- **脱敏自检告警**：扫一遍残留的邮箱/疑似人名/疑似客户名等——
  对应 `redact.mjs` 自承「内容级脱敏未做」，至少给红旗，别假装干净。

可选 `brain preview --raw` 看蒸馏后的 `.jsonl` 上传体本身。

### 4.3 按条 opt-out —— `brain optout`
**上传前（便宜、纯客户端、信任主力）**：
- 本地 opt-out 名单：`~/.team-brain/optout`（gitignore 范畴的本机文件），
  记 session id / 文件路径 / glob。daemon 在 `gated()` 之外再过一道
  `optedOut(file|id)`，命中即**永不上传**并在账本记 `opted_out`。
- CLI：`brain optout <id|file>` 加；`brain optout --list`；`brain optout --rm <id>`。
  `brain mine` 行内也能直接 opt-out。
- 顺带支持一个 `.team-brain-ignore`（gitignore 风格、按 session 文件 glob），
  补 `exclude`（子树级）够不到的**文件级**粒度。

**已传后撤回 —— `brain retract <id>`（贵、需服务端、Phase 3）**：
- 新端点 `POST /retract`（token 鉴权，**只能撤自己 producer_id 的**）：
  git 删除该 session 的 `.md`/`.jsonl` 并 commit。
- 诚实告知：默认只从 HEAD 移除，**git 历史仍可考古**；要真抹需额外历史重写（重活、慎做）。
- 同时把该 id 自动加入本机 opt-out，防 daemon 下一轮又传回去。

## 5. 顺手降低「默认就吓人」
`collect_all`（安装没填工作空间时的默认）最吓人。首次 `--once` 回填后给一条总结：
> 这台机器将上传 N 个项目、约 M 条 session。`brain mine` 看明细，`brain optout` 排除。

一次性 onboarding nudge，把「不知不觉全传了」变成「我知道、我能改」。

## 5b. 已拍板的方向（讨论收敛）

- **默认仍自动传**：不引入「先审后传」hold 模式。viewer 是**事后**看 + 管 + 随时排除/撤回。
- **主界面 = 本机 localhost 查看器**（127.0.0.1，仅本人可见），把预览 / 排除 / 撤回 / 配置 / 日志揉在一处。
  与线上共享库强视觉区分（深色 ribbon「本机控制台」）。原型见 [`web/viewer-mock.html`](../web/viewer-mock.html)。
- **控制是事后式**：逐条「排除」（未传的永不传 / 已传的撤回）+「编辑」（overlay 二次脱敏）。
- **脱敏两层都暴露**：内置自动规则只读展示 + 个人脱敏词表（自定义、只存本机、带本机命中计数）。
- 中心 Web 暂不做「我的足迹」（足迹在本地看）；服务端只负责后期的**配置快照上报**（透明）。
- localhost 安全：仅绑 loopback + 本地 token；客户端保持轻量（Node 内置 `http`，不引 express）。

## 6. 开发计划（里程碑）

> 状态（截至本轮）：**M1 ✅ 完成**、**M2 ✅ 基本完成**（除 overlay 手改编辑器外全部落地），M3 待做。
> 落地代码：`core/ledger.mjs`·`core/selfcheck.mjs`·`core/optout.mjs`·`core/userredact.mjs`·`client/viewer.mjs`·`server/retract.mjs`·`web/viewer.{html,js}`；改 `client/sync.mjs`·`cli/brain.mjs`·`server/server.mjs`。
> 验证：全套 144 测试通过；viewer 6 个 API + 排除→服务端撤回→文件删除全链路、个人词表命中计数、配置 dry-run 均实测通过。
> 仍缺：**overlay 手改编辑器**（逐 turn/逐段手动划掉）—— 个人脱敏词表已覆盖大部分「手动兜底」诉求，overlay 留作 M3。


### M1 · 地基 + 只读足迹（纯客户端，零服务端，零行为变更）
打开黑盒。
- `core/ledger.mjs`（新）：结果账本状态机 `uploaded | pending | skipped(reason) | opted_out` + 元信息（坐标/intent/体积/flags）。
- 改 `client/sync.mjs`：每条处理后写账本，替换现在无差别的 `seenSession.set(file,m)`；兼容旧 `.brain-state.json`。
- `client/viewer.mjs`（新）：Node `http` 起 127.0.0.1 + 本地 token，serve `web/` + JSON API：
  `/api/overview`、`/api/sessions`、`/api/session/:id`（本地 `projectSession(slimRaw(file))` 出**真**预览 + 原文 + 脱敏自检）、`/api/log`（读 `sync.log`）。
  （嵌进常驻 daemon 还是独立进程 = M1 第一个工程决定）
- `cli/brain.mjs`：`brain viewer`（开浏览器）；`brain status` 打印 URL。
- `web/`：把 mock 接成 fetch 真数据。
- 脱敏自检：扫邮箱 / 疑似人名 / 长数字串 → flags。

### M2 · 控制（排除 + 撤回 + 配置编辑 + 个人词表）
- 逐条**排除**：本地 optout 名单；daemon 在 `gated()` 前过滤；记账本 `opted_out`。
- **撤回**（已传）：新端点 `POST /retract`（token 鉴权，只允许撤自己 `producer_id`）→ git rm `.md`/`.jsonl` + commit；client + viewer 按钮；自动加 optout 防重传。**诚实标注 git 历史仍可考古**。
- **配置可视化**：viewer 写 `client.config.yaml`；保存前 dry-run「多传 N / 少传 M」。
- **个人脱敏词表**：本地存（`~/.team-brain/redact.local`）；接进上传前 slim/redact 流水（决定：仅对新上传生效，还是回溯重传已传的）。
- overlay 编辑器（手动二次脱敏，不碰源文件）——此处或挪 M3。

### M3 · 透明 + 打磨
- 服务端 **config-report**：client 心跳上报有效配置（姿态，**不含**敏感：exclude 路径/optout 内容/词表只报数量）；服务端 per-person 存；中心 web 加「全队配置 / 覆盖度」页（对等透明）。
- overlay 编辑器（若未做）。
- 测试（ledger / viewer API / retract / 个人词表）、文档（README + AGENTS 不变量）、灰度。

**建议从 M1 起跑**：纯客户端、零行为变更，立刻把黑盒打开。M2 再上控制（含唯一的服务端新增 `/retract`），M3 做团队级透明。

## 7. 仍需边做边定的工程点
1. viewer 嵌入常驻 daemon vs 独立进程（单例锁 / `--once` 交互）。
2. 个人词表对**已上传**历史是否回溯重传。
3. 撤回语义：HEAD 移除够不够，还是要抹 git 历史。
