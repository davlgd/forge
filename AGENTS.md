# Contributing to Forge

Keep source code, comments, interface copy and documentation in English. Write
for people using or maintaining the project. README.md covers usage and hosting;
CHANGELOG.md records release changes. Keep work plans, reviews, audit reports and
agent transcripts outside the repository; do not track them or add ignore rules
for them.

## README style

Keep paragraphs to three source lines at most, with balanced breaks at logical boundaries.
Avoid short trailing lines and unnecessary prose; retain actionable steps and useful explanations.
Order bullets by subject, then by line length where that preserves a natural reading order.

## Implementation

- Prefer small, direct changes. Apply DRY, KISS and SOLID where they reduce complexity; avoid speculative abstractions.
- Keep GitHub API access in `crates/github-api`, a thin adapter over `github-rust`, independent of the server and its environment variables.
- Let `github-rust` handle queries, pagination and concurrency; preserve Forge's response format and sanitized errors in the adapter.
- Use Rust edition 2024 and TypeScript. Bun builds frontend assets through `build.rs`; generated JavaScript is not source code.
- Keep dependencies useful and current. Commit Cargo.lock and bun.lock when dependencies change.
- Use Mise for tasks and local environment configuration, not tool or dependency version management.
- Preserve read-only GitHub access, the proxy username allowlist, local CLI access restrictions, and private data boundaries.
- Keep both themes, system preference, keyboard focus and mobile actions usable.

## Development tasks

Install Rust, Bun and Mise separately. Run `mise trust` after inspecting the task
configuration. Development tasks install their required Bun dependencies from
the lockfile automatically. Optional `.env` settings are local; never load
`.env.deploy` into the development workflow. Keep deployment secrets under that
name: Bun install can auto-load `.env.production` even with dotenv loading disabled.

| Task                        | Purpose                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `mise run build`            | Build the release binary and embedded frontend.                        |
| `mise run run`              | Start the local dashboard.                                             |
| `mise run demo`             | Start with fictional data and no GitHub credentials.                   |
| `mise run dev`              | Run the development workflow.                                          |
| `mise run test`             | Run Rust unit tests.                                                   |
| `mise run check`            | Check formatting, types and code quality.                              |
| `mise run format`           | Format Rust, TypeScript and documentation.                             |
| `mise run test-browser`     | Run the browser regression checks against a running server.            |
| `mise run test-browser-ci`  | Build, start an isolated demo server and run asset and browser checks. |
| `mise run package <target>` | Archive and smoke-test an already built native release target.         |

Before submitting, run formatting, checks, tests and a release build. Rust
formatting must pass `cargo fmt --all -- --check`; Clippy must pass
`cargo clippy --workspace --all-targets --locked -- -D warnings`. Investigate
warnings instead of suppressing them. Run `cargo machete`, `cargo outdated
--root-deps-only` and `cargo audit` when changing dependencies, with those Cargo
subcommands installed. Use relevant tests rather than adding tests that merely
repeat implementation details.

## Browser checks

After installing development dependencies, install Chromium:

```sh
bunx --bun playwright install chromium
```

Start `mise run demo` in one terminal and `mise run test-browser` in another.
Tests supply fictional Forge API responses. They cover filtering,
sorting, actual issue/PR titles and destinations, progressive synchronization,
cache expiry, account-switch cancellation and recovery, mobile layouts, themes,
language-list expansion, keyboard focus and HTML escaping. Partial results must
remain marked incomplete until every section finishes. Keep cached GitHub data in authenticated, bounded server memory and tab memory,
isolated by credential and account; never persist responses or tokens in browser
storage. Only interface preferences belong in localStorage. Cover cache replay,
expiry, forced refresh, cancellation and authentication before cache lookup.
Use WCAG 2.2 AA as the accessibility target: check text and control contrast,
visible keyboard focus, disclosure dismissal, sortable table semantics, minimum
24 CSS pixel targets and reflow. Browser checks are not a full accessibility audit. Verify maintainer tasks, not just the shape of the
interface: an issue/PR view must contain actionable conversations, never another
filtered repository list. Screenshots are generated test artifacts; never replace their
fixtures with private repositories or account data.

Use `DASHBOARD_URL` for a different server URL and `CHROMIUM_PATH` for an existing
Chromium executable. An explicit `VERIFY_LIVE=1 mise run test-browser` additionally
checks the account connected to a local CLI-mode server without capturing its
data. Browser and unit tests do not verify a deployed OAuth callback: validate
that separately when changing hosted authentication.

## CI and releases

GitHub Actions runs the same Mise checks and browser workflows used locally. Bun's
CI version is declared in `package.json`; Mise remains a task runner. Keep actions
pinned to verified release commits and check workflow edits with `actionlint`.
Dependabot checks Cargo and GitHub Actions dependencies weekly; review its updates through CI.
Check Bun dependencies with `bun outdated`; Dependabot cannot yet read this project's `bun.lock` format.

Release tags must match both Cargo manifests, `package.json` and a CHANGELOG entry.
The release workflow tests four native targets, packages each executable with its
documentation, and runs it from an empty directory with no external tools in PATH.

Only the publishing job gets write permission. It verifies all archives and checksums,
checks that the tag still points at the tested commit, and uploads a draft before publication.
Failures leave the release unpublished; a rerun can finish an existing draft.

After a public release, create a new SemVer version and tag instead of moving the old tag.
For a manual retry, select the matching tag in the Release workflow or run
`gh workflow run release.yml --ref MAJOR.MINOR.PATCH`.

To test packaging locally, build a supported native target with
`cargo build --release --locked --target <target>`, then run `mise run package <target>`.
Generated archives and SHA256 sidecars live in the ignored `dist/` directory.
