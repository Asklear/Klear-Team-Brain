# Self-hosting Klear-Team-Brain

Klear-Team-Brain is self-hosted and single-tenant: **you** run the server, and nothing leaves your infrastructure. This guide covers the server — the fastest way is **[Docker](#docker)** (one command), or a manual setup on a small VPS — plus the client machines.

> **Where to host:** the asking side uses an LLM and needs to reach GitHub, so pick a region where your LLM provider and GitHub are reachable. The truth store holds your team's work — keep the host private to your circle and back it up.

---

## Docker

The fastest way to stand up a server — needs Docker + Docker Compose. (Prefer manual setup? Skip to [section 1](#1-server-one-vps).)

```bash
git clone https://github.com/Asklear/Klear-Team-Brain.git && cd Klear-Team-Brain
docker compose up -d                        # builds + runs the server on http://localhost:8787
docker compose logs server | grep token     # the access token it auto-mints on first boot
```

What you get: the server binds to **loopback only** (`127.0.0.1:8787` — reachable from this host, not the public internet), persists its truth store in a named volume, and bootstraps a roster + token into `./config/` on first boot. To point a client at it, put `server_url: http://localhost:8787` + the token from the logs into a `client.config.yaml` — see the [manual client path](#2-clients-each-dev-machine). (Don't use `npm run quickstart` here — that mints its *own* separate token under the repo root, which this container won't recognize.)

- **Port already taken?** `HOST_PORT=8788 docker compose up -d`.
- **Real domain + HTTPS:** bring up the bundled Caddy reverse proxy (automatic TLS):
  ```bash
  DOMAIN=brain.you.com PUBLIC_URL=https://brain.you.com docker compose --profile tls up -d
  ```
  Caddy terminates HTTPS on 443 and proxies to the server over the internal network — `8787` never leaves the container network. (Point your domain's DNS at the host first.)
- **More members:** edit `./config/team.yaml` + `./config/tokens.yaml`, then `docker compose restart server`.
- **Enable code-state / Feishu polling:** set `NO_POLL=0` and drop `registry.yaml` / `feishu.yaml` into `./config/`.
- **Behind a flaky network / firewall** (e.g. China): if the build fails pulling `node:22-slim` or Debian packages mid-download (`unexpected EOF`), set a registry mirror in Docker's daemon settings and retry — Docker resumes partial layers, so a few retries usually get through.

---

## 1. Server (one VPS)

### 1.1 Install Node 22+ and git

```bash
sudo apt update && sudo apt install -y git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
```

### 1.2 Get the code + install deps

```bash
git clone https://github.com/Asklear/Klear-Team-Brain.git /opt/team-brain
cd /opt/team-brain
npm install --omit=dev
```

### 1.3 Roster + tokens

Two files hold who's in: `team.yaml` (roster — id / name / email / git-name aliases; no secrets, safe to keep on the server) and `tokens.yaml` (**secret, never commit** — one random token per member). Two ways to fill them:

**Recommended — `server/admin.mjs add` (writes both + prints an invite code).** Run it on the server (after the service in §1.6 is up — it restarts the service to apply):

```bash
node server/admin.mjs add alice --name "Alice" --server-url https://brain.yourdomain.com
```

This appends Alice to `team.yaml` + `tokens.yaml`, restarts the service, and prints a `BRAIN-…` **invite code** plus a ready-to-send onboarding message. That invite code is exactly what `brain join` expects in [section 2](#2-clients-each-dev-machine).

> **From your own machine:** once your laptop's `client.config.yaml` has an `admin: { ssh, dir }` block (pointing at the server's SSH target + code dir — see `client.config.example.yaml`), you can run the same thing locally: `brain admin add alice --name "Alice"`. It SSHes in and runs `server/admin.mjs` for you, so you don't need to log into the box. Same for `brain admin who` / `rm` / `org` / `repo` / `gitlab` / `gitea`.

**Manual alternative.** Create the files by hand — copy `team.example.yaml` → `team.yaml`, and `tokens.example.yaml` → `tokens.yaml` with one `openssl rand -hex 24` per member. Members set up this way use the **manual client path** in §2 (raw token in `client.config.yaml`) — `brain join` takes an invite code, not a raw token.

### 1.4 Pick a durable, backed-up path for the truth store

```bash
export TRUTH_DIR=/var/lib/team-brain/truth   # the authoritative git truth store — back it up
```

The truth store is a plain git repo — it's the whole value of the system and **can't be rebuilt**, so back it up. A simple cron-able snapshot:

```bash
git -C "$TRUTH_DIR" bundle create /backups/truth-$(date +%F).bundle --all   # single-file, restore with: git clone <bundle>
# or just: tar czf /backups/truth-$(date +%F).tgz -C "$TRUTH_DIR" .
```

> On a low-RAM VPS, avoid `git gc --aggressive` on the truth store — it can OOM. Plain `git gc` (or letting git auto-gc) is fine.

### 1.5 HTTPS (easiest: Caddy auto-certs)

`/etc/caddy/Caddyfile`:

```
brain.yourdomain.com {
    reverse_proxy localhost:8787
}
```

Point the domain's A record at this VPS; Caddy issues and renews certs automatically.

### 1.6 Run as a service (systemd)

`/etc/systemd/system/team-brain.service`:

```ini
[Unit]
Description=Klear-Team-Brain server
After=network.target

[Service]
WorkingDirectory=/opt/team-brain
Environment=PORT=8787
Environment=TRUTH_DIR=/var/lib/team-brain/truth
Environment=TOKENS_FILE=/opt/team-brain/tokens.yaml
ExecStart=/usr/bin/node server/server.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now team-brain
curl https://brain.yourdomain.com/health   # {"ok":true,"version":"…","truth":{"dir":true,"git":true,"writable":true}}
```

> `/health` does a cheap readiness check of the truth store (exists / is a git repo / writable) and returns **HTTP 503** with the failing field if any check fails — point your uptime monitor at it and alert on non-2xx.

> The server binds `127.0.0.1` by default, so port 8787 is **not** reachable on the public IP — only the Caddy/HTTPS front door is. Keep it that way: if your reverse proxy runs on a different host (e.g. Docker), set `Environment=HOST=0.0.0.0` **and** firewall 8787 so only the proxy can reach it. Never expose 8787 to the internet directly (that bypasses TLS → tokens travel in plaintext).

> Raw sessions are stored unredacted on disk (the redacted `.md` is what the query layer surfaces). Security rests on HTTPS + keeping this host open **only to your circle** + token auth. Don't push the truth store to any public remote.

### 1.7 Optional: code state (GitHub / GitLab / Gitea)

Create `registry.yaml` (copy from `registry.example.yaml`, **secret → gitignored**) to register the orgs/repos that should become first-class spaces, each with a read-only PAT. A global `GITHUB_TOKEN` (env or `GITHUB_TOKEN_FILE`) is the fallback. With either configured, `read_github` + the 4h code-state poll are enabled.

Beyond GitHub, **self-hosted GitLab and Gitea** are first-class too — `registry.example.yaml` shows the multi-instance shape (host + base URL + token, with group/project or org/repo entries), and you can maintain them from your own machine with `brain admin gitlab …` / `brain admin gitea …`.

> Code-state only includes branches pushed within the last **30 days**. Long-lived release branches that go quiet drop out of view — raise the window with `Environment=CODESTATE_ACTIVE_DAYS=365` to keep them. If `GITHUB_TOKEN_FILE` is set but unreadable, the server logs a warning at startup and runs as if no token were configured (so `read_github` would otherwise report a misleading "no permission").

### 1.8 Optional: doc mirror (Feishu/Lark · Notion · Google Docs)

Mirror human-written team docs into the truth store (one-way) so the asking agent can `grep`/`read` them alongside sessions and code. Each source is gated by its own secret yaml (leave it out → that layer stays quietly off), and all follow the same "share with the bot, then it mirrors" model:

- **Feishu / Lark** — copy `feishu.example.yaml` → `feishu.yaml`, fill in your custom-app `app_id`/`app_secret`, restart. The full walkthrough (creating the app, scopes, and the **non-obvious whole-wiki authorization step** — you can't add the app directly; you add a *group containing the app's bot* as a wiki admin) is in the README under *Optional: mirror team docs (Lark / Feishu)*.
- **Notion** — copy `notion.example.yaml` → `notion.yaml`, fill `api_token`, **share** the pages/databases with your integration, restart.
- **Google Docs** — copy `google.example.yaml` → `google.yaml`, point it at a service-account JSON key, **share** the docs/folders with the service account's email, restart.

All are **secret → gitignored**. Each polls every `poll_hours` (default 4).

### 1.9 Optional: in-dashboard Q&A (`ASK_ENABLED`)

The web dashboard can host a natural-language "ask one question" box that answers over the truth store. It's **off by default** and spawns a server-side `codex` process per question, so it has cost/latency implications and needs `codex` installed on the server. Enable + tune via env:

| Var | Default | What it does |
|---|---|---|
| `ASK_ENABLED` | (off) | Set `1` to enable the `/ask` endpoint + the dashboard Q&A box. |
| `ASK_CODEX_BIN` | `codex` | Path to the codex binary the server spawns. |
| `ASK_CODEX_ARGS` | `exec --skip-git-repo-check` | Args passed to codex. |
| `ASK_CWD` | `TRUTH_DIR` | Working directory (defaults to the truth store, so codex can `grep`/`read` the `.md` directly). |
| `ASK_TIMEOUT_MS` | `120000` | Per-question timeout. |
| `ASK_MAX_CONCURRENT` | `2` | Max concurrent questions before returning `429`. |

### 1.10 Environment variables (reference)

Everything the server honors (all optional; sensible defaults shown):

| Var | Default | Purpose |
|---|---|---|
| `TRUTH_DIR` | `<repo>/truth-server` | The authoritative git truth store. **Set this to a durable, backed-up path** (§1.4). |
| `PORT` | `8787` | Listen port. |
| `HOST` | `127.0.0.1` | Bind address. Keep loopback behind a proxy; only set `0.0.0.0` with a firewall (§1.6). |
| `TEAM_FILE` | `<repo>/team.yaml` | Roster path. |
| `TOKENS_FILE` | `<repo>/tokens.yaml` | Member tokens (secret). |
| `REGISTRY_FILE` | `<repo>/registry.yaml` | Registered orgs/repos + PATs (secret). |
| `GITHUB_TOKEN` / `GITHUB_TOKEN_FILE` | — | Global fallback GitHub token (§1.7). |
| `CODESTATE_ACTIVE_DAYS` | `30` | Active-branch window for code-state (§1.7). |
| `FEISHU_FILE` / `NOTION_FILE` / `GOOGLE_FILE` | `<repo>/<name>.yaml` | Doc-source credentials (§1.8). |
| `NO_POLL` | (off) | `1` disables all background polling (code-state + doc sources) — useful for static/dev. Note: the Docker image defaults this to `1`. |
| `PUBLIC_URL` | request `Host` | The base URL baked into the `curl …/get \| bash` install script. **Set it when behind a proxy** so members get the right install URL. |
| `ASK_*` | — | In-dashboard Q&A (§1.9). |

---

## 2. Clients (each dev machine)

The simplest path uses the server's self-hosted client bundle + the invite code from §1.3:

```bash
curl -fsSL https://brain.yourdomain.com/get | bash   # downloads the client + registers the `brain` command
brain join BRAIN-xxxxxxxx                             # the invite code from `server/admin.mjs add` — verify + pick workspaces + wire MCP + first sync + install resident
```

`brain join` is interactive: confirm the workspaces to collect, acknowledge the privacy notice, done. After that, keep using Claude Code / Codex as usual — sessions flow into the brain automatically. (`brain join` takes the `BRAIN-…` code, not a raw token — if you provisioned tokens manually in §1.3, use the manual path below instead.)

Manual alternative (raw token — clone + configure):

```bash
git clone https://github.com/Asklear/Klear-Team-Brain.git team-brain && cd team-brain && npm install
cp client.config.example.yaml client.config.yaml      # set server_url, your token, me.id/name, upload_folders
```

Then run `client/sync.mjs` as a resident service (launchd on macOS, systemd user service on Linux) and add the MCP server:

```bash
claude mcp add team-brain --scope user -- node /path/to/team-brain/mcp/server.mjs
```

---

### `client.config.yaml` reference

`brain join` generates this for you; to adjust, edit it directly and `brain service restart` to apply.

```yaml
server_url: https://brain.yourdomain.com
token: "<your token>"       # handed to you out-of-band; secret, never commit to any repo
me:
  id: your-id               # must match your entry in the roster — don't change it
  name: Your Name
upload_folders:             # the collection allowlist — the field you'll touch most
  - /Users/you/Code/team-stuff   # a session uploads only if its cwd is under one of these
exclude:                    # subdirectories to keep private
  - /Users/you/Code/team-stuff/secret
# collect_all: true         # ignore upload_folders and collect ALL sessions on this machine
                            # (what the installer sets when you pick no workspaces — don't use on machines with secrets/client data)
codex: true                 # also collect ~/.codex/sessions
session_history_md: true    # also collect session_history/**/*.md under upload_folders
trae_memory: true           # also collect Trae's native session memory under upload_folders
interval_sec: 60            # how often to scan, in seconds
debounce_sec: 60            # seconds a session must be idle before it's "stable" enough to upload
# auto_update: false        # default on: the resident self-updates from the server daily; set false to pin
```

Day to day only two fields change: add a project to `upload_folders` when you pick it up (not in the list = never uploaded), or add a subdir to `exclude` to keep it private — `brain service restart` after either. `token` and `me.id` are your identity: changing `me.id` breaks per-person lookups, a wrong `token` means `401`. The file holds a secret and is gitignored — never commit it.

## 3. Rolling out

Start with 2 people, run a few days, and check: are searches accurate, is the upload gate doing the right thing, do cross-machine upload and Q&A feel smooth? Then add the rest to `team.yaml` + `tokens.yaml`, hand out tokens, and have each person configure their client.

## Daily ops

```bash
brain status              # resident status + last sync + collection footprint (uploaded/skipped)
brain viewer              # open the local footprint console (127.0.0.1): see/exclude/retract what this machine uploads
brain logs -f             # collector logs
brain update              # pull latest client from the server + restart resident
brain service restart     # restart the resident after config/code changes
brain uninstall           # stop resident + remove MCP + delete token config
brain admin add|who|rm    # (admins only, needs the admin: block) manage the roster from your machine over SSH
```

## Troubleshooting

| Symptom | Check |
|---|---|
| `brain: command not found` right after install | Open a new terminal (or `source` your shell rc) — the installer adds `~/.local/bin` to your PATH. In a pinch, call it directly: `~/.team-brain/cli/brain.mjs <cmd>`. |
| My work isn't showing up in the brain | `brain status` — is the resident running? Is the project directory under `upload_folders`? `brain logs -f` to see collection errors. |
| `401` on sync or queries | Token is wrong or was revoked — get a fresh one from whoever runs the server. |
| Can't ask from the editor | `brain mcp` to re-wire the MCP server, then restart the editor. |
| A session from a shared repo landed in a personal `local__…` bucket | That repo isn't registered in `registry.yaml` — register it (§1.7) so it becomes a shared space; sessions before registration stay in the personal bucket (still searchable). |
| Server admins say the client was upgraded | `brain update` (no need to re-run the `curl … \| bash`). |
