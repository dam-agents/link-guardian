# humr-bot

The operating manual and tools for **humr-bot**, a Claude Code agent run by [Humr](https://github.com/kagenti/humr) to perform recurring maintenance work on Kagenti's public repositories.

## What it does

humr-bot is a general-purpose maintenance agent. Each capability lives as a Claude Code skill under `.claude/skills/`. The first skill is:

- **`check-broken-links`** — walks markdown docs across configured repos, classifies broken external and relative links, and opens a single tracking issue per repo with what to fix.

More skills can be added alongside without changing the invocation model.

## How Humr runs it

Humr schedules a Claude Code session with this repo as the working directory and a persistent volume at `./state/` (PVC, gitignored). Cron invocations point the agent at a skill; the agent follows that skill's `SKILL.md` and invokes the colocated TypeScript tools via `pnpm exec tsx`.

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

## Development

```sh
pnpm install
pnpm test          # vitest, covers both deep modules
pnpm typecheck
```

The deep modules (`check-links.ts`, `reconcile-state.ts`) are pure-ish and fully unit-testable without network access. The agent layer (`SKILL.md`) is verified by running the bot against a test repo; it is not unit-tested.

## Design

- **Deterministic TypeScript** owns link extraction, HTTP classification, relative-path resolution, and state reconciliation. Correctness of link-checking does not depend on which LLM runs the agent.
- **The agent layer** handles judgment calls that don't belong in deterministic code: onboarding conversation, composing issue bodies, learning user-stated ignore rules, and deciding when to escalate.

See [PRD kagenti/humr#283](https://github.com/kagenti/humr/issues/283) for the product rationale and full user stories.
