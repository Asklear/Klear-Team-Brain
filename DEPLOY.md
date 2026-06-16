# Self-hosting Klear-Team-Brain

Klear-Team-Brain is self-hosted and single-tenant: **you** run the server, and nothing leaves your infrastructure. This guide covers a server (one small VPS) plus client machines.

> **Where to host:** the asking side uses an LLM and needs to reach GitHub, so pick a region where your LLM provider and GitHub are reachable. The truth store holds your team's work — keep the host private to your circle and back it up.

> **Docker:** a `docker-compose` setup is on the roadmap. For now, the steps below are the supported path.

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

- `team.yaml` — your roster (id / name / email / git name aliases). No secrets; safe to keep on the server. Copy from `team.example.yaml`.
- `tokens.yaml` — **secret, never commit** — one random token per member:
  ```bash
  cp tokens.example.yaml tokens.yaml
  openssl rand -hex 24    # generate one per member, fill them in
  ```

### 1.4 Pick a durable, backed-up path for the truth store

```bash
export TRUTH_DIR=/var/lib/team-brain/truth   # the authoritative git truth store — back it up
```

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
curl https://brain.yourdomain.com/health   # {"ok":true}
```

> Raw sessions are stored unredacted on disk (the redacted `.md` is what the query layer surfaces). Security rests on HTTPS + keeping this host open **only to your circle** + token auth. Don't push the truth store to any public remote.

### 1.7 Optional: GitHub code state

Create `registry.yaml` (copy from `registry.example.yaml`, **secret → gitignored**) to register the GitHub orgs/repos that should become first-class spaces, each with a read-only PAT. A global `GITHUB_TOKEN` (env or `GITHUB_TOKEN_FILE`) is the fallback. With either configured, `read_github` + the 4h code-state poll are enabled.

### 1.8 Optional: doc mirror (Lark / Feishu)

Mirror a Lark/Feishu **wiki** into the truth store (one-way) so the asking agent can `grep`/`read` your team docs alongside sessions and code. Copy `feishu.example.yaml` → `feishu.yaml` (**secret → gitignored**), fill in your custom-app credentials, and restart. Leave it out and the doc layer stays quietly off.

The full walkthrough — creating the app, which scopes to enable, and the **non-obvious whole-wiki authorization step** (you can't add the app directly; you add a *group containing the app's bot* as a wiki admin) — is in the README under *Setting up the doc mirror (Lark / Feishu)*.

---

## 2. Clients (each dev machine)

The simplest path uses the server's self-hosted client bundle:

```bash
curl -fsSL https://brain.yourdomain.com/get | bash   # downloads the client + registers the `brain` command
brain join <INVITE_TOKEN>                             # verify + pick workspaces + wire MCP + first sync + install resident
```

`brain join` is interactive: confirm the workspaces to collect, acknowledge the privacy notice, done. After that, keep using Claude Code / Codex as usual — sessions flow into the brain automatically.

Manual alternative (clone + configure):

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
codex: true                 # also collect ~/.codex/sessions
interval_sec: 60            # how often to scan, in seconds
debounce_sec: 60            # seconds a session must be idle before it's "stable" enough to upload
```

Day to day only two fields change: add a project to `upload_folders` when you pick it up (not in the list = never uploaded), or add a subdir to `exclude` to keep it private — `brain service restart` after either. `token` and `me.id` are your identity: changing `me.id` breaks per-person lookups, a wrong `token` means `401`. The file holds a secret and is gitignored — never commit it.

## 3. Rolling out

Start with 2 people, run a few days, and check: are searches accurate, is the upload gate doing the right thing, do cross-machine upload and Q&A feel smooth? Then add the rest to `team.yaml` + `tokens.yaml`, hand out tokens, and have each person configure their client.

## Daily ops

```bash
brain status              # resident status + last sync
brain logs -f             # collector logs
brain update              # pull latest client from the server + restart resident
brain service restart     # restart the resident after config/code changes
brain uninstall           # stop resident + remove MCP + delete token config
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
