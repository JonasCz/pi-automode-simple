# AGENTS.md

## Project overview

This repository is `pi-automode-simple`, a Pi / oh-my-pi (omp) extension that gates `bash`, `eval`, `terminal`, and `computer` tool calls. It asks the Jev decision model on OpenRouter for a danger score and requires user confirmation for risky calls, classifier errors, and every gated call while auto mode is off.

This is not a sandbox. Do not describe it as one.

## Important files

- `extensions/auto-mode-simple.ts`: the whole extension. Default export is the extension factory. Pure helpers and `createAutoModeSimple({ fetch })` are exported for tests.
- `tests/auto-mode-simple.test.ts`: Node test suite (`node:test`, `node:assert/strict`).
- `README.md`: user-facing documentation.
- `package.json`: package metadata, Pi manifest, scripts, dev dependencies.

## Issue tracking

Track issues in GitHub. Use the `gh` CLI for issue operations.

GitHub Issues has no `Draft` state. Create captured tickets as open issues and state that they are Drafts in the description.

Use `bug` for defects, `enhancement` for behavior changes, and `documentation` for documentation-only work.

## Development commands

Run these before handing off code changes:

```bash
npm run check
npm test
```

For package/release-sensitive changes, also run:

```bash
npm pack --dry-run
```

## Coding conventions

- TypeScript is strict, ESM, NodeNext (`tsconfig.json`). Tab indentation.
- Keep everything in one small, explicit file. Avoid abstractions.
- No runtime dependencies. Do not import host packages (`@earendil-works/*`, `@oh-my-pi/*`); the host API is described by minimal local interfaces so the extension loads in both Pi and omp.
- Keep extension state (enabled flag, cache) inside the `createAutoModeSimple()` closure, not at module level.
- Fail closed: missing API key, network errors, timeouts, non-2xx responses, missing or malformed answers, and hook exceptions must lead to user confirmation, or a block when there is no UI. Never allow on error.

## Hook behavior

`tool_call` handling, in order:

1. Tools other than `bash`, `eval`, `terminal`, `computer`: return `undefined` (untouched).
2. Turn already aborted: block with `Cancelled`.
3. Auto mode off, or tool is `computer`: ask the user (no Jev call).
4. Otherwise ask Jev. Danger `< 0.35`: allow. Danger `>= 0.35` or error: ask the user.
5. Asking: no UI blocks; confirmed allows; declined or a rejected confirm blocks.

## Testing expectations

Use red/green TDD for behavior changes: first add or update a test that demonstrates the missing behavior, then implement the smallest passing change.

Tests inject `fetch` and must not touch the network, the user's `OPENROUTER_API_KEY`, or the real log file (set `AUTOMODE_SIMPLE_LOG`). Bug fixes to blocking/allowing behavior need tests that prove the observed behavior is fixed.

## Safety rules for this repo

This project is itself a safety-control extension. Treat these areas as high risk:

- the set of gated tools and the danger threshold;
- fail-closed handling of classifier errors and hook exceptions;
- Jev question wording and the state sent to Jev;
- which conversation content counts as trusted user input (user messages and `ask` answers only, never other tool output);
- on/off persistence and restore.

Do not weaken safety behavior, add allow shortcuts, or bypass the classifier without explicit user direction and tests. Changes to docs must not imply guarantees the extension does not provide.

## Pi extension references

Key host API constraints used by this project:

- `tool_call` can block by returning `{ block: true, reason }`.
- Classify the requested action; do not mutate `event.input`.
- Check `ctx.hasUI` before UI-only behavior.
- Pass `ctx.signal` to nested requests and confirmations.
- `pi.appendEntry()` persists extension state outside LLM context; restore from `ctx.sessionManager.getBranch()` on `session_start`.

## Documentation rules

- Keep `README.md` user-facing, concrete, and short.
- Keep security wording precise: this extension reduces unsafe autonomous tool use; it is not an OS-level security boundary.
- Keep the command list in sync with `extensions/auto-mode-simple.ts`.

## Git hygiene

- Check `git status --short` before committing or making broad edits.
- Do not overwrite unrelated user changes.
- Do not edit `.env` files or local Pi/omp config unless explicitly asked.
- Commit only when explicitly asked.
