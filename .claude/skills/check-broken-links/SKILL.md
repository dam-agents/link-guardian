---
name: check-broken-links
description: Walk markdown in configured repos, classify broken external and relative links, maintain one tracking issue per repo.
---

# check-broken-links

Scan markdown in each configured target repo, classify broken links, and keep one tracking issue per repo up to date.

## State layout

Everything persistent lives under `./state/` (gitignored, on a persistent volume):

- `./state/MEMORY.md` — config: target org and repo list.
- `./state/skip-patterns.txt` — learned ignore rules. See [Ignore rules](#ignore-rules) below for format.
- `./state/repos/<owner>-<repo>.json` — per-repo bookkeeping. Structure matches `State` in `reconcile-state.ts`.

Target repos are cloned to `./repos/<owner>/<repo>/`; reuse with `git pull` if the clone exists.

## Run loop

### 1. Ensure configuration

Read `./state/MEMORY.md`. If it doesn't exist, or the target list is empty:

- Ask the user (chat) which org to watch. List repos with `gh repo list <org> --limit 200 --json name,description`; let them confirm, edit, or say "all".
- Write the answer to `./state/MEMORY.md` under `## Targets`, one `owner/repo` per line.

Do not link-check until `MEMORY.md` has a concrete target list.

### 2. For each target repo

For `owner/repo` in the target list:

**a. Refresh the clone.** If missing, `gh repo clone <owner>/<repo> repos/<owner>/<repo>`. Otherwise `git -C repos/<owner>/<repo> pull --ff-only`.

**b. Determine the tracking issue's state.** The wrapper does no `gh` calls, so this lookup happens here:

- If `state/repos/<owner>-<repo>.json` has `trackingIssueNumber`, query `gh issue view <n> --repo <owner>/<repo> --json state --jq .state` and map `OPEN`→`open`, `CLOSED`→`closed`.
- Otherwise, do a title-based lookup (state-loss recovery). The title is stable across all repos (`[Bug]: broken links`):
  ```
  gh issue list --repo <owner>/<repo> \
    --search '"[Bug]: broken links" in:title' \
    --state all --limit 5 --json number,state,title
  ```
  Filter to entries where `title` exactly equals `[Bug]: broken links` (the search is fuzzy):
  - **No match** → `absent`.
  - **One open match** → `open`. Patch `trackingIssueNumber: <n>` into the state file before running the wrapper.
  - **One closed match** → `closed`. Don't patch (wrapper resets on closed).
  - **Multiple matches** → log numbers, skip the repo, surface to user. Don't guess.

**c. Scan tracking issue comments for ignore directives** (only if state is `open` or `closed`):
```
gh issue view <n> --repo <owner>/<repo> --json comments \
  --jq '.comments[] | {body, author: .author.login, createdAt}'
```
For any comment that says "ignore X" (e.g. *"ignore flaky.example.com, it rotates IPs"*), translate to a regex and append to `state/skip-patterns.txt` with a `#`-prefixed rationale line above. Dedupe before appending — re-running on the same comment must not duplicate.

**d. Run the wrapper:**
```
pnpm exec tsx .claude/skills/check-broken-links/run.ts \
  --repo-root repos/<owner>/<repo> \
  --state-file state/repos/<owner>-<repo>.json \
  --tracking-issue-state <open|closed|absent> \
  --plan-out /tmp/plan-<owner>-<repo>.json \
  --body-out /tmp/body-<owner>-<repo>.md \
  [--skip-patterns-file state/skip-patterns.txt]
```
The wrapper reads prior state, scans links, reconciles, persists next state, and writes the action plan and (if needed) issue body.

**e. Execute the plan** at `/tmp/plan-<owner>-<repo>.json`:

- `none` → done.
- `open` → `gh issue create --repo <owner>/<repo> --title "<plan.title>" --body-file <plan.bodyFile>`. Capture the new issue number `n` from the URL and patch `trackingIssueNumber: n` into the state file.
- `update` → `gh issue edit <plan.issueNumber> --repo <owner>/<repo> --body-file <plan.bodyFile>`.
- `close` → `gh issue close <plan.issueNumber> --repo <owner>/<repo> --comment "<plan.comment>"`.

The wrapper deliberately omits `trackingIssueNumber` from the open-case state file. Patch it in only after `gh issue create` succeeds; a failed call leaves state recoverable.

## Issue title

The title is the constant `[Bug]: broken links` — same for every repo, since `gh` already shows the issue under its `owner/repo`. Don't change this; the title-based recovery in step 2 depends on it. The wrapper produces the body; you just pass `--body-file <plan.bodyFile>` to `gh`.

## Error handling

- `gh repo clone` / `git pull` fails → log, skip the repo, continue.
- Wrapper throws → log, skip the repo. State on disk is untouched.
- `gh issue create/edit/close` fails *after* the wrapper succeeded → log and continue. Reconciliation is idempotent over the same findings, so the next run retries. Exception: a failed `open` must not patch `trackingIssueNumber`, so next run sees `absent` and retries.

## Guardrails

- Never push, branch, or open PRs in target repos.
- Don't modify files under `./repos/<owner>/<repo>/` beyond what `git pull` does.

## Ignore rules

The user can teach the bot a new ignore rule two ways:

1. In chat during an interactive session.
2. In a comment on the tracking issue (handled by step 2c).

Either way, append to `state/skip-patterns.txt`. Format is one regex per line; blank lines and `#`-prefixed lines are ignored by the wrapper, so use `#` lines for rationale immediately above each pattern. Example:

```
# Rotates IPs, repeatedly false-positive (chat with user 2026-04-12)
flaky\.example\.com

# Internal-only host
^https://internal\.local/
```

This file is the only place ignore rules live. Don't edit code or `SKILL.md` to add them.
