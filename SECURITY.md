# Security Policy

Klear-Team-Brain handles sensitive data: it aggregates redacted full-text transcripts of a team's AI coding sessions, plus tokens, GitHub PATs, and doc-source credentials. We take security seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, report privately via one of:

- GitHub's [private vulnerability reporting](https://github.com/Asklear/Klear-Team-Brain/security/advisories/new) (preferred), or
- email the maintainers at **neiyouser2@gmail.com**.

Please include: a description of the issue, steps to reproduce or a proof of concept, affected versions/components, and any suggested mitigation.

We aim to acknowledge reports within a few business days and will keep you updated on remediation. Please give us reasonable time to fix the issue before any public disclosure.

## Scope & deployment notes

Klear-Team-Brain is **self-hosted and single-tenant**. Operators are responsible for:

- Serving over HTTPS and exposing the server **only to your circle** (raw sessions are stored unredacted on disk; the redacted `.md` is what the query layer surfaces).
- Keeping secrets server-side and gitignored: `tokens.yaml` (member tokens), `registry.yaml` (GitHub PATs), `feishu.yaml` (doc-source credentials), `client.config.yaml`.
- **Never pushing the truth store to a public remote**, and backing it up within your circle.
- Rotating member tokens and PATs as people join/leave (revocation takes effect on server restart).

If you find a misconfiguration risk that the project could prevent by default, we'd love an issue or PR for that too (non-sensitive hardening can be discussed publicly).
