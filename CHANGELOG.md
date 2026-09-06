# Changelog

Forge uses Semantic Versioning. During `0.x` development, minor releases may
change configuration or APIs; patch releases contain compatible fixes. From
`1.0.0`, breaking changes require a major version. Record notable user-facing
changes here and use matching `MAJOR.MINOR.PATCH` release tags.

## 0.1.0 — 2026-09-06

Initial release.

- Automated tests and downloadable Linux, macOS and Windows archives with embedded web assets and SHA256 checksums.
- Authenticated 30-minute server cache with configurable expiry, reload reuse and forced refresh.
- Unified tab cache with progressive synchronization, current-view priority and background completion of all sections.
- Personal and organization dashboards with repository totals and popularity rankings.
- Compact issue and pull request inboxes with direct conversation links, search, relevant repository and assignee filters, and PR review status.
- Explicit repository type filters and issue/PR counters scoped to active repositories.
- Compact language statistics with an expandable complete list.
- Direct GitHub links, responsive layouts and keyboard navigation.
- Styled workspace and avatar menus with theme controls and sign-out.
- Readable sortable table headings with remembered direction, workspace, view and filters.
- Light and dark themes with system preference and a saved appearance setting.
- GitHub access through `github-rust`, local authentication through GitHub CLI and a demo with fictional data.
- OAuth2 Proxy authentication with a GitHub username allowlist for hosting.
- Clever Cloud deployment guide and portable OAuth2 Proxy configuration.
