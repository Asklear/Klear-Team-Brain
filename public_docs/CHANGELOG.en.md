# Changelog

English | [中文](./CHANGELOG.zh-CN.md)

This project follows [Semantic Versioning](https://semver.org/), formatted after [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Check your local version with `brain version`.

> Still pre-1.0 and early, incrementing by patch. Formal versioning began at `v0.1.11`; earlier versions are a retroactive split of the development history by milestone.

---

## [0.1.16] - 2026-06-24 · Self-updating client

### Added
- **Self-updating client**: the resident collector checks once a day and, when the server has a newer client, updates itself and restarts on the new code — no more manual `brain update`. On by default; can be disabled in config (`auto_update: false`).
- **Trae session memory capture**: native session memory produced while working in [Trae](https://www.trae.ai/) now lands in the memory too (on by default, still gated to `upload_folders`).

### Changed
- **Stats counted on the day the work happened**: sessions spanning multiple days are no longer attributed entirely to their start day, but split by actual workday; daily bucketing consistently uses Beijing time (UTC+8).

### Fixed
- **Fixed token usage showing 0 for heavy Codex users**: redaction had been clobbering Codex's numeric token counters; usage is now accurate and split precisely by day. History is backfilled automatically from the originals on your machine after upgrading.

## [0.1.15] - 2026-06-23 · Easier capture, secrets never leave, lighter client

### Added
- **Capture-all by default**: when `brain join` / `setup` is run without naming workspaces, all of your local sessions are captured (local docs still gated by the `upload_folders` allowlist); pure consumers keep an empty allowlist to opt out.

### Changed
- **Client-side redaction before upload**: secrets / tokens / URL-embedded credentials are masked to placeholders **before** a session ever leaves your machine, so the raw `.jsonl` in the memory contains no secrets; the byte-exact original stays on the producer's machine. Rules are a high-confidence subset of gitleaks.
- **Install size 59M → 24M**: the client installs only the deps it actually uses, dropping the server-only Feishu SDK; `brain update` cleans up old leftovers automatically.
- **Huge Codex sessions no longer dropped**: capture is now streamed line-by-line, so multi-hundred-MB rollouts ingest fine (older versions skipped them entirely over a size cap).

### Fixed
- Added a backfill script to redact secrets in historical sessions, so content ingested before the upgrade is covered too.

## [0.1.14] - 2026-06-23 · Aggregate stats

### Added
- **Stats dashboard**: a new read-only query `stats` (MCP tool + Web "Stats" page). Aggregates **token usage / session count / conversation turns** by day / week / person / repo / tool, with multi-dimension grouping, orthogonal split, and reverse-chronological pagination. Aggregated by real work time.

## [0.1.11] - 2026-06-18

### Added
- `brain version` to check the client version.
- Introduced this `CHANGELOG` and retroactively tagged the development history.

## [0.1.10] - 2026-06-18

### Added
- **GitLab / Gitea** support (GitHub unchanged, zero migration); register self-hosted instances / groups / projects.

## [0.1.9] - 2026-06-18

### Added
- **Web browsing UI**: a static dashboard to browse the team's spaces / sessions / docs / activity, fully bilingual.
- Fuller markdown rendering, noise collapsed by default (large code blocks / metadata / repeated messages), session stats and sharing.

## [0.1.8] - 2026-06-16

### Added
- Session-history markdown sync.

### Fixed
- MCP client gained timeouts + retries to survive TLS packet loss on cross-border links.

## [0.1.7] - 2026-06-13

### Added
- **Open-source release**: LICENSE / bilingual README / CONTRIBUTING / SECURITY / Code of Conduct / deploy docs + publish pipeline.
- CI (secret scanning) + issue / PR templates.

## [0.1.6] - 2026-06-11

### Added
- Onboarding guide; `upload_folders` supports `~` expansion.

### Changed
- Deploy switched to the server pulling from GitHub main, establishing **main = production**.

## [0.1.5] - 2026-06-10

### Added
- **One-way Feishu / Lark doc mirror**: wiki bodies pulled incrementally into the memory, covered by the existing `grep` / `read` with no new tools.

## [0.1.4] - 2026-06-09

### Added
- **Session distillation v2**: subtract by record type (drop telemetry / dedup / truncate giant tool outputs and reasoning), fixing oversized sessions that overwhelmed the server; one-time migration of existing data.
- Search sessions by person and real work time, fixing missed results for "what did X do last week."

### Fixed
- Codex sessions take their real branch / remote, fixing history all tagged as main.
- A single bad file no longer stalls the whole capture pass.

## [0.1.3] - 2026-06-08

### Changed
- **Space-identity refactor**: unify coordinates around the code repo as the identity center, including repo-move redirection.

## [0.1.2] - 2026-06-06

### Added
- `brain update`: pull the latest client code from the server and restart the resident.
- Auto-backfill of history for the new scope after `upload_folders` changes.

### Fixed
- Auto-configure PATH when `npm link` fails, no more command-not-found.

## [0.1.1] - 2026-06-06

### Added
- Read-only query primitives `grep` / `ls` / `log` + built-in MCP usage docs.
- Client robustness + full uninstall; one-command MCP re-wire (Claude Code + Codex).

## [0.1.0] - 2026-06-04

### Added
- **Team-brain baseline**: capture Claude Code / Codex sessions → git memory → ask over MCP.
- `brain` CLI for one-shot install / start / stop; end-to-end onboarding (one command to add a member, one command for them to join).

### Security
- Two security audits: closed path traversal, fixed concurrent-attribution issues, and more.
