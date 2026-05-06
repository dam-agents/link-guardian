# dam-bot

The operating manual and tools for **dam-bot**, a Claude Code agent run by [DAM](https://github.com/dam-agents/dam) to perform recurring maintenance work on DAM's public repositories.

## What it does

dam-bot is a general-purpose maintenance agent. Each capability lives as a Claude Code skill under `.claude/skills/`. The first skill is:

- **`check-broken-links`** — walks markdown docs across configured repos, classifies broken external and relative links, and opens a single tracking issue per repo with what to fix.

More skills can be added alongside without changing the invocation model.

## How DAM runs it

DAM schedules a Claude Code session with this repo as the working directory and a persistent volume at `./state/` (PVC, gitignored). Cron invocations point the agent at a skill; the agent follows that skill's `SKILL.md` and invokes the colocated TypeScript tools via `pnpm exec tsx`.

On the first run in a fresh workspace, the bot detects that `state/MEMORY.md` is missing and asks the user which org and repos to watch. The answer is written to `state/MEMORY.md` and reused on subsequent runs.

State layout on the PVC:

```
state/
├── MEMORY.md                 # org + repo list, learned ignore rules (future)
└── repos/
    └── <owner>-<repo>.json   # per-repo debounce counters, known-broken list, open issue ref
repos/
└── <owner>/<repo>/           # clones of target repos, refreshed via `git pull` each run
```

## Deployment

### GitHub authentication

dam-bot uses a GitHub fine-grained PAT, injected as a secret on the agent at runtime. Choose the scope based on what you want the bot to do:

- **Read content + write issues (default).** Enough for skills like `check-broken-links` that only open/update tracking issues on target repos.
- **Self-evolution via PR only (opt-in).** If you want the bot to propose changes to *itself* — e.g. a skill that updates `.claude/skills/` or runtime configuration — give it a PAT scoped to `dam-agents/dam-bot` with `contents: write` **on non-default branches** and `pull-requests: write`. The bot pushes to a feature branch and opens a PR; a human reviews and merges. **Do not grant merge rights to the bot.** Rationale in [Security model](#security-model) below.

> **Do not** give the bot a PAT that can push directly to `main` on `dam-bot`. See the [security model](#security-model) below for why that scope is an arbitrary-code-execution foothold.

### Envoy credential injection

DAM's Envoy credential-gateway sidecar injects the PAT on the wire — the agent container never sees the raw token. Register the secret via DAM's Connections panel as a Generic secret:

- **Host pattern:** `github.com`
- **Header name:** `Authorization`
- **Value format:** `Basic {value}`
- **Value:** `base64(x-access-token:<PAT_TOKEN>)`

Create the agent from the Claude Code template, attach the secret to the agent, and bootstrap the workspace with:

```sh
git clone https://github.com/dam-agents/dam-bot.git
```

Subsequent runs reuse the clone and `git pull` on startup.

## Security model

dam-bot inherits DAM's overall security posture — see [DAM security model](https://github.com/dam-agents/dam/blob/main/docs/strategy/security-model.md). Specifically, dam-bot holds all three legs that make an agent dangerous: **[A] untrusted input** (markdown from arbitrary PR authors on target repos), **[B] sensitive capability** (a GitHub PAT), and **[C] external state change** (opening issues, outbound HTTP, talking to the LLM provider). Safety here comes from keeping **[B]** narrow (default: read + issues only) and gating self-evolution on a human PR review — the bot has no merge rights on its own repo.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
```

## Design

- **Deterministic TypeScript** owns link extraction, HTTP classification, relative-path resolution, and state reconciliation. Correctness of link-checking does not depend on which LLM runs the agent.
- **The agent layer** handles judgment calls that don't belong in deterministic code: onboarding conversation, composing issue bodies, learning user-stated ignore rules, and deciding when to escalate.

See [PRD dam-agents/dam#36](https://github.com/dam-agents/dam/issues/36) for the product rationale and full user stories.
