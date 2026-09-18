# AGENTS.md

Guidance for coding agents working in this repository. The README is written
for a human deciding whether to use NewPi; this file is the map for an agent
about to change it. Read this first, then the one document that matters for the
task — do not read the README end to end, it is long on purpose.

## What this is

NewPi is a native macOS app (Tauri) that owns a window and launches the DeepSeek
Harness runtime as a separate process, with a pinned PocketBase sidecar for
durable per-project memory. The Rust host owns the process; the harness owns the
page; plugins bridge the two.

| Path | What lives there |
| --- | --- |
| `src-tauri/` | the Rust host: window, runtime lifecycle, sidecar, deploy, patch |
| `plugins/` | the Cordis plugins NewPi deploys, one directory per feature |
| `ui/index.html` | the page the harness serves, with the plugins' sections injected |
| `scripts/` | verification probes, storage tooling, packaging helpers |
| `tests/` | `node --test` suites, plus live PocketBase and backup proofs |
| `pb_migrations/` | the memory schema, applied by the sidecar at boot |
| `vendor/pocketbase/` | the pinned, checksum-verified sidecar archive |
| `docs/` | `features.md` (what exists, in French) and `storage-audit.md` |

## Commands

```sh
pnpm install      # Tauri CLI, plus copies of the harness modules for the tests
pnpm test         # cargo test FIRST, then node --test tests/*.test.mjs
pnpm dev          # the app, with Rust reload; the first build takes minutes
pnpm build:app    # just the .app — prefer this while iterating
pnpm storage      # what is using the disk, and the only safe cleanups
```

The order in `pnpm test` is not cosmetic: `cargo test` dumps
`src-tauri/target/test-tmp/launcher-sample.patch.yml`, and the JavaScript suites
read it. Running `node --test tests/*.test.mjs` alone silently skips those
assertions, so use `pnpm test` when it matters.

Verification probes, each one a real proof rather than a smoke test:

| Command | Needs |
| --- | --- |
| `pnpm test:pocketbase` | the pinned binary, no running app |
| `pnpm test:backup` | the pinned binary, isolated projects |
| `pnpm verify:running` | a NewPi instance already running |
| `pnpm verify:console` | `NEWPI_WEB_URL` with its token |
| `pnpm verify:projects`, `:git`, `:capability` | Google Chrome, and they mount their own harness |

The four probes drive `/Applications/Google Chrome.app` over its own DevTools
socket — there is no Playwright install. `pnpm verify:console` starts nothing:
it needs the URL the app prints at launch, token included, and `pnpm dev` prints
it in clear text.

## What will bite you

- **`pnpm install` and `node_modules/@deepseek-ai`.** `scripts/link-harness-modules.mjs`
  copies the harness packages the tests import into the checkout. They must stay
  **real directories**: pnpm tries to `chmod` a package directory that is a
  symlink, and a link whose target leaves the project cannot be written through,
  so the install dies with `EPERM ... chmod .../@deepseek-ai/cordis/bin.js` and
  exit 255 — before any lifecycle script runs, so no `preinstall` can fix it. If
  you find that state, the only cure is `rm -rf node_modules/@deepseek-ai` once,
  then `pnpm install`.
- **`pnpm` is not always on the PATH.** On this machine the working binary is
  `~/Library/pnpm/pnpm` (v10.33.2). Its store defaults inside the project at
  `.pnpm-store/`, which is gitignored.
- **Do not read the README as the spec of the code.** `README.md` and
  `docs/features.md` state, in French, what has been *verified*; when you change
  behaviour, the claim in that table is what goes stale.
- **The page never receives a secret.** The sidecar's URL and password reach the
  harness through the environment (`DSH_MEMORY_URL`, `DSH_MEMORY_PASSWORD`); the
  console reads no variable at all. Anything that would put either on the page
  is a bug, not a shortcut.
- **The page cannot name a project.** A `project_id` sent by the page is refused;
  the server decides. The same applies to what may be confirmed: `confirm: true`
  comes from the button, and the model re-checks it.

## Conventions

- **Code, comments, JSDoc and Rust doc comments are in English.** The README,
  `docs/`, and the strings a user reads in the UI are in French.
- **No semicolons** in JavaScript. Every module opens with a header comment
  saying what it owns and what it deliberately does not.
- **A comment explains a decision, never a mechanism.** If a line is subtle
  enough to need one, say why the obvious alternative is wrong.
- **Never commit, push, or force anything on your own initiative.** This
  repository is the user's, and its history starts from a single initial commit.
- Configuration is data, not code: a plugin row's config travels in the launcher
  patch, and no secret is ever part of it.

## Where to look, by task

| The task | Read first |
| --- | --- |
| memory, backups, the sidecar | `src-tauri/src/memory.rs`, then `docs/features.md` |
| a section in the UI | the matching `plugins/*-console/`, then `ui/index.html` |
| context, prompt cache, handoff | `plugins/context-cache-manager/context.js` — its header is the model |
| which model a call uses | `plugins/model-router/` |
| disk usage, cleanups | `plugins/storage-console/catalog.js`, then `docs/storage-audit.md` |
| packaging, the icon, the bundle | `scripts/make-icon.mjs`, `scripts/clean-bundle.mjs` |
