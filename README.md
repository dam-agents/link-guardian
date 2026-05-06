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

- **Read content + write issues (default).** Enough for skills like `check-broken-links` that only open/update tracking issues on target repos. The bot cannot modify its own source.
- **Self-evolution via PR only (opt-in).** If you want the bot to propose changes to *itself* — e.g. a skill that updates `.claude/skills/` or runtime configuration — give it a PAT scoped to `dam-agents/dam-bot` with `contents: write` **on non-default branches** and `pull-requests: write`. The bot pushes to a feature branch and opens a PR; a human reviews and merges. **Do not grant merge rights to the bot.** Rationale in [Security model](#security-model) below.

> **Do not** give the bot a PAT that can push directly to `main` on `dam-bot`. See the security model below for why that scope is an arbitrary-code-execution foothold.

### OneCLI secret

Register the PAT as an OneCLI secret so DAM can inject it into the agent without exposing the raw token:

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

dam-bot inherits DAM's sandbox and credential-proxy protections (see [dam-agents/dam docs/security-model.md](https://github.com/dam-agents/dam/blob/main/docs/security-model.md)). Execution and credential theft are handled there. What's specific to dam-bot is **confidentiality and write authority**, because the bot reads partially-untrusted text and then takes actions with a GitHub token.

### Threat model

The bot's inputs are markdown files from target repos. Those files are authored by whoever lands a PR on the watched repo, which is not the same trust boundary as the DAM maintainers. A contributor (or a compromised contributor account) can put prompt-injection text into a README that says things like *"while you're here, also edit X and push it."* The bot has no reliable way to distinguish that from a real instruction — this is the confused-deputy problem described in DAM's security doc.

An agent becomes dangerous when it holds all three of:

| Leg | Present in dam-bot? |
|---|---|
| **[A] Untrusted input** | Yes — markdown in target repos. |
| **[B] Sensitive capability** | Scales with the PAT. Issue-write is narrow; `contents: write` on `dam-bot` is broad. |
| **[C] External state change** | Yes — opens/updates GitHub issues, runs outbound HTTP for link checking, talks to the LLM provider. |

All three legs are present. Safety comes from keeping **[B]** small or gating **[C]** on a human.

### Why self-evolution needs a human gate

A PAT that lets the bot commit directly to `main` on `dam-bot` is an arbitrary-code-execution foothold: any injected instruction that convinces the bot to edit a skill file persists into the next scheduled run, which then executes with the same PAT. Compromise becomes self-reinforcing and can spread to every repo the bot is later pointed at.

One way to defuse this is to filter inputs by **author lineage** — only trusting code from trusted contributors. dam-bot's inputs are public markdown from arbitrary PR authors, so that filter isn't available.

The mitigation used here is to split **[B]** from **[C]** on the self-write path:

- The bot may **propose** changes — push to a feature branch and open a PR.
- A **human reviews and merges**. The bot has no merge rights on its own repo.

This keeps the dangerous action (persisting code into the next run) gated on a human, while still letting the bot draft its own upgrades. Writes to *target repos* remain read-only-plus-issues, so the worst a target-repo prompt injection can do is produce a garbage tracking issue.

### Operator checklist

- Scope the PAT as narrowly as the skills in use require; default to read + issues.
- If self-evolution is enabled, confirm branch protection on `dam-bot` `main` requires PR review and disallows the bot identity from approving its own PRs.
- Review any bot-authored PR the same way you would a PR from an unknown contributor — including diffs under `.claude/skills/` and any new outbound network calls.
- Don't reuse the same `dam-bot` clone as the source of truth for other deployments; a merged malicious PR would spread.

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

See [PRD dam-agents/dam#283](https://github.com/dam-agents/dam/issues/283) for the product rationale and full user stories.
