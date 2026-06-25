# Contributing to Klear-Team-Brain

Thanks for your interest! Issues and pull requests are welcome.

## How this repo works

Klear-Team-Brain is **developed internally and published here as a sanitized mirror.** That means:

- This repo is the canonical public home for issues, discussion, and PRs.
- Maintainers review and merge contributions upstream; they then flow back into this mirror on the next release. So a merged PR may appear here as part of a later snapshot commit rather than your original commit — your authorship is preserved in the credits, and we'll note it on the PR.

## Development setup

**Prerequisites:** Node 22+.

```bash
git clone https://github.com/Asklear/Klear-Team-Brain.git
cd Klear-Team-Brain
npm install
npm test          # node:test, zero extra deps
```

The codebase is plain ES modules (`.mjs`), no build step.

- `core/` — pure logic (parsing, coordinates, redaction, registry decisions)
- `client/` — the resident collector that watches session jsonl
- `cli/` — the `brain` command
- `mcp/` — the MCP stdio server (the read-only query primitives)
- `server/` — ingest, query, code-state, doc mirror, admin
- `test/` — unit + integration tests

## Pull requests

1. Open an issue first for anything non-trivial, so we can agree on the approach.
2. Keep PRs focused; match the style of the surrounding code.
3. **Add or update tests** for behavior changes — `npm test` must pass.
4. Don't include secrets, credentials, or real personal data in code, tests, or fixtures.
5. Describe what changed and why in the PR body.

## Reporting bugs

Open an issue with: what you expected, what happened, steps to reproduce, and your Node version / OS.

## Security

Please do **not** open public issues for security vulnerabilities. See [SECURITY.md](./SECURITY.md).

## Code of conduct

By participating you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).
