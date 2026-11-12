# pi-automode-simple

A small auto-mode guard for Pi and oh-my-pi (omp). Before the agent runs a shell command, code, or terminal action, the extension asks the Jev decision model on OpenRouter how dangerous it is. Low-danger calls run. Anything risky, and any classifier failure, needs your confirmation.

**This is not a sandbox and not a security boundary.** It reduces unsafe autonomous tool use. It does not stop a determined or compromised agent, and it does not inspect tools it does not gate. Jev can be wrong in both directions.

## Gated tools

| Tool       | Auto mode on                         | Auto mode off  |
| ---------- | ------------------------------------ | -------------- |
| `bash`     | classified by Jev                    | always confirm |
| `eval`     | classified by Jev (includes browser) | always confirm |
| `terminal` | classified by Jev                    | always confirm |
| `computer` | always confirm                       | always confirm |

All other tools (`read`, `write`, `edit`, …) pass through untouched.

## Decision rule

1. The extension sends the action, working directory, your last 6 messages, your last 6 answers to the `ask` tool, and the project rules file (below) to `~typesafe/jev-latest` via `https://openrouter.ai/api/alpha/decisions`. Secrets that match common token patterns are redacted first. Other tool output is never sent.
2. Jev answers three questions: `is_dangerous`, `exfiltrates_or_destroys`, `violates_user_instructions`. The danger score is the highest answer.
3. Danger below `0.35`: the call runs.
4. Danger `0.35` or higher, or any error (no API key, timeout after 12 s, HTTP error, malformed answer): you are asked to confirm. Without a UI (for example print mode), the call is blocked.

The OpenRouter key comes from the host's OpenRouter login, falling back to `OPENROUTER_API_KEY`.

## Commands

- `/automode on`: classify with Jev (default).
- `/automode off`: confirm every gated call.
- `/automode` or `/automode status`: show the current state.

The setting is saved in the session and restored when you resume it.

## Project rules

If `.agent/auto-mode-classifier-rules.md` exists in the working directory, its first 6,000 characters are sent to Jev as `project_rules`. Use it for instructions like "never push to main" or "never touch the production database".

This file is repo-controlled text. It can make Jev stricter, but it can also argue Jev into allowing things. Treat it as trusted only in repositories you trust.

## Install (omp)

Add the extension to `~/.omp/agent/config.yml` and let it be the only gate for these tools:

```yaml
extensions:
  - /path/to/pi-automode-simple/extensions/auto-mode-simple.ts

tools:
  approval:
    bash: allow
    eval: allow
    terminal: allow
    computer: allow
```

In Pi, install the package or point your extension settings at `extensions/auto-mode-simple.ts`.

## Seeing decisions

- The status row shows the state and the latest decision, e.g. `auto: on · bash allowed · risk 5%`.
- Each allowed or confirmed gated call gets one line appended to its tool result, e.g. `[auto-mode] allowed · Jev risk 5% · confidence 95%`. The line is visible in the tool box and is also seen by the model.
- Blocked calls show the reason, including the Jev score, as the tool error.

## Log

Each decision is appended as one JSON line to `$AUTOMODE_SIMPLE_LOG`, or `~/.omp/agent/auto-mode-simple.log` if `~/.omp/agent` exists, else `~/.pi/agent/auto-mode-simple.log`. Fields: `ts`, `tool`, `action` (first 300 characters, redacted), `enabled`, `danger`, `top`, `error`, `outcome`.

## Development

```bash
npm install
npm run check
npm test
```

## License

MIT, see [LICENSE.md](LICENSE.md).
