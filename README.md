# Klear-Team-Brain

[![CI](https://github.com/Asklear/Klear-Team-Brain/actions/workflows/ci.yml/badge.svg)](https://github.com/Asklear/Klear-Team-Brain/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

> **Your team's collective memory for AI-assisted coding.**
>
> Everyone keeps using Claude Code / Codex as usual; their sessions automatically flow into one shared **git truth store** — fused with live GitHub code state and your team's docs. Then anyone can ask, straight from their editor over MCP, *"where did X land, how was it decided, who's working on Y"* and get an answer synthesized across the team's **sessions, code, and docs**. Self-hosted, privacy-gated, zero extra effort for the people doing the work.

English | [中文](./README.zh-CN.md)

> **Status:** early, self-hosted, single-tenant. You run your own server; nothing leaves your infrastructure. See [Self-hosting](./DEPLOY.md).

---

## Why

Goals, progress, and reasoning are scattered across people's heads, docs, code, and chat logs that vanish when you close the tab. Klear-Team-Brain pools them into one place that can be searched and synthesized on demand — so understanding no longer has to route through a single person.

## The core idea

**Only the "truth" is kept; "views" are disposable.**

- **Truth layer (substrate)** = the raw material (sessions / docs / code state) + metadata (who / type / repo / branch / time). It's the one thing kept clean and complete, because truth is expensive and can't be rebuilt; views are cheap and rebuildable. Underneath it is a single **git repository**.
  - Sessions are stored in a **distilled** form (`core/slim.mjs`): inline image base64 stripped, giant tool outputs truncated — signal, not bytes. The byte-exact original stays on the producer's machine (`~/.codex` / `~/.claude`).
- **View layer (understanding)** = an index/query over the truth. Free-form, swappable, throwaway. Today it's "ask an agent, answered live."

One loop, not two things:

```
   produce (do the work) ───▶ persist ───▶ understand (consume)
   CC/Codex write code         into git truth store    ask an agent (MCP)
   /docs/research              each tagged who·repo·branch·time   "where did X land?"
        ▲                                                          │
        └───────────── understanding makes the next step sharper ──┘
```

**Where each kind of thing comes from** (this is the basis for fusing them):

| Dimension | Lives mainly in | In the truth store |
|---|---|---|
| **Progress · reasoning** | CC/Codex sessions | `sessions/<branch>/` (slim jsonl + redacted full-text transcript md) |
| **Code progress** | GitHub | not stored; fetched on demand + 4h poll into `code-state.md` |
| **Goals · decisions (human-written)** | Team docs (Lark/Feishu wiki) | `feishu/<wiki>/…`: one-way mirror of doc bodies; grep/read it, edit at the source |

## How it works

```
each machine (client)                          your server (self-hosted)
┌────────────────────────┐            ┌──────────────────────────────────┐
│ collector client/sync   │  gzip+token │ server/server.mjs (HTTP, HTTPS via │
│  resident, watches jsonl │ ──────────▶ │  a reverse proxy like Caddy)       │
│  gated by upload_folders │            │  /ingest → git truth store TRUTH_DIR│
│                          │            │   spaces/github__o__r | local__person│
│ ask an agent  mcp/server │  search+fetch│  /grep /find /read /ls /log /github │
│  from inside CC/Codex    │ ◀────────── │  + 4h GitHub poll → code-state      │
└────────────────────────┘            └──────────────────────────────────┘
```

People doing the work **do nothing extra**; people who want to understand **ask one question**.

## Quick start

**Prerequisites:** Node 22+, and at least one MCP-capable editor/CLI (Claude Code or Codex) to ask questions from.

1. **Stand up a server** (one small VPS). See [DEPLOY.md](./DEPLOY.md) — install Node, clone, set `TRUTH_DIR`, add a roster + tokens, put HTTPS in front, run as a service.
2. **Onboard a client** — point it at your server and join:
   ```bash
   curl -fsSL https://your-server.example.com/get | bash   # downloads the client + registers the `brain` command
   brain join <YOUR_INVITE_TOKEN>                           # verify + pick workspaces + wire up MCP + first sync + install resident
   ```
3. **Ask, from your editor.** Once MCP is wired up, ask in Claude Code / Codex: *"where did the auth refactor land?"*, *"who's working on billing?"*, *"how did we decide the schema?"*

## Setting up the doc mirror (Lark / Feishu)

Optional. If your team keeps human-written docs (goals, decisions, notes) in a Lark/Feishu **wiki**, the server can one-way **mirror** those doc bodies into the truth store, so the asking agent can `grep`/`read` them alongside sessions and code. Set it up once:

1. **Create a custom app** in the Lark/Feishu developer console (an *enterprise custom app*); note its **App ID** + **App Secret** — the server exchanges these for a `tenant_access_token`.
2. **Enable read scopes** under the app's *Permissions*, then publish a version and have an admin approve it: `docx:document.readonly`, `drive:drive.readonly`, `wiki:wiki.readonly`. (You don't need a search scope — tenant-token native search is unreliable, so the mirror is searched locally.)
3. **Authorize the app on the whole wiki — the non-obvious step, and the one that actually gates access.** A tenant-token app can only see wikis it's been explicitly added to, and the console **won't let you add an app directly**. Instead:
   1. Create a group / chat.
   2. Add **this app's bot** to that group — it must be the bot of the *same* App ID (adding the wrong bot is the most common failure).
   3. In the wiki, go to **Settings → Members → Roles & permissions → Admins → Add admin** and add **that group**.

   The app then has read access to the *entire* wiki. Propagation takes ~1–2 minutes.
4. **Drop the credentials on the server:** copy `feishu.example.yaml` → `feishu.yaml` (**secret → gitignored**), fill in `app_id` / `app_secret`, and restart the service. Leave `feishu.yaml` out entirely and the doc layer stays quietly off.
5. **Verify:** after a poll cycle, the wiki's docs appear under `feishu/<wiki>__<space_id>/…` in the truth store, searchable via `grep`.

> China Feishu (`open.feishu.cn`) and international Lark (`open.larksuite.com`) are isolated platforms — create the app on whichever one your team uses. Create a **new** wiki later? Repeat step 3 for it, or the brain won't see it.

## Asking (the MCP tools)

The truth store is exposed to the asking agent as a **read-only folder** via a handful of Unix-style primitives, all tied together by truth-store-relative `path`:

| Tool | What it does |
|---|---|
| `grep` | Search content (regex full-text via git grep). Defaults to `.md` (redacted transcripts); `raw=true` includes `.jsonl`. |
| `find` | Find files by name/glob. (grep searches content, find searches names — complementary.) |
| `read` | Read any file by path (paginate large files with offset/limit). |
| `ls` | Inspect structure: which spaces exist, branches, session counts. |
| `log` | Activity timeline (the truth store's git history; narrow by space/author/since). |
| `read_github` | Reach out to GitHub for live code state or a file's current contents (code itself isn't stored). |

Server-side queries run via `git grep` / `git ls-files` / `git log` / `fs` — **execFile, no shell, locked inside `TRUTH_DIR`, read-only** — so the agent can locate, read, and map the repo like a local folder, with no server-side LLM.

**Wiring other editors:** the MCP server is a stdio server; the command is always `<node> <install-dir>/mcp/server.mjs` (`brain mcp` prints your exact path). Add that as a stdio MCP server in Claude Code, Codex, or any MCP-capable client (Gemini CLI / Cursor / Cline / opencode…).

## Privacy & security

- **Scope gate:** a session is uploaded only if its working directory is under your machine's `upload_folders` allowlist — inside the circle is shared by default, outside is private by default.
- **Redaction:** the derived `.md` transcript is run through redaction (secrets/tokens + home-directory paths) when projected on the server, with a second pass at the `/read` exit.
- **Tokens / PATs:** member tokens, GitHub PATs, and doc-source credentials all live server-side and are gitignored; the roster (no secrets) can be committed.
- **The truth store is the whole value — never push it to a public remote, and back it up.** Self-host on infrastructure open only to your circle.

## Non-goals

It aggregates and helps you understand what's in CC/Codex sessions + GitHub + docs. It is **not** an IM, a project manager, or a code host, and doesn't replace them.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) and [SECURITY.md](./SECURITY.md). This project is developed internally and mirrored here; external contributions are reviewed and merged upstream, then flow back out.

## License

[Apache-2.0](./LICENSE) © Asklear
