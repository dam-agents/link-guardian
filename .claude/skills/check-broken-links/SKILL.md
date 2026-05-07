---
name: check-broken-links
description: Walk markdown in configured repos, classify broken external and relative links, maintain one tracking issue per repo.
---

# check-broken-links

You are running the broken-link-detection skill for dam-bot. Your job is to scan markdown files in each configured target repo, classify links that are broken, and keep exactly one tracking issue per repo up to date with what needs fixing.

## State layout

Everything persistent lives under `./state/` on the PVC:

- `./state/MEMORY.md` — human-readable config: which GitHub org to watch, which repos, plus any learned ignore rules the user has taught you. Gitignored.
- `./state/repos/<owner>-<repo>.json` — per-repo debounce/bookkeeping state. Gitignored. Structure matches `State` in `reconcile-state.ts`.

Target repos are cloned to `./repos/<owner>/<repo>/`. If a clone already exists, `git pull` instead of re-cloning.

## Run loop

### 1. Ensure configuration

Read `./state/MEMORY.md`. It should list at least one target org or repo. If it does not exist, or the section describing target repos is empty:

- Ask the user via chat which GitHub org to watch. List the repos in that org (via `gh repo list <org> --limit 200 --json name,description`) and ask the user to confirm the list, edit it, or say "all".
- Write the answers to `./state/MEMORY.md` under a `## Targets` section, one `owner/repo` per line.
- Then continue.

Do not proceed with link-checking until `MEMORY.md` contains a concrete target list.

### 2. For each target repo

For `owner/repo` in the target list:

1. Ensure a local clone exists at `./repos/<owner>/<repo>/`. If missing, `gh repo clone <owner>/<repo> repos/<owner>/<repo>`. If present, `git -C repos/<owner>/<repo> pull --ff-only`.

2. Determine the tracking issue's current state. This is the only piece the wrapper cannot compute itself:
   - If `state/repos/<owner>-<repo>.json` exists and contains a `trackingIssueNumber`, query `gh issue view <n> --repo <owner>/<repo> --json state --jq .state` and map `OPEN`→`open`, `CLOSED`→`closed`.
   - Otherwise, run the **title-based lookup** below before falling back to `absent`.

   **2a. Title-based lookup (state-loss recovery).** If the state file is missing or has no `trackingIssueNumber`, search the target repo for an existing tracking issue by title before opening a new one. The title is stable (`[Bug]: broken links in <repo>`), so this prevents duplicate issues when state is lost (e.g., PVC re-mount, accidental clear).
   ```
   gh issue list --repo <owner>/<repo> \
     --search '"[Bug]: broken links in <repo>" in:title' \
     --state all --limit 5 --json number,state,title
   ```
   Filter the result to entries where `title` exactly equals `[Bug]: broken links in <repo>` (the `--search` is fuzzy):
   - **No match** → use `absent`.
   - **One open match** → use `open`, and patch `trackingIssueNumber: <n>` into `state/repos/<owner>-<repo>.json` *before* running the wrapper, so the wrapper carries the number into next state.
   - **One closed match** → use `closed`. Do not patch the number; the wrapper resets debounce on closed and a new issue (if needed) will be opened next.
   - **Multiple matches** (rare — humans opened a duplicate) → log the issue numbers, skip this repo, and surface to the user. Do not guess.

3. Run the sweep wrapper. It reads prior state, scans links, reconciles, persists next state, renders the issue body, and emits an action plan:
   ```
   pnpm exec tsx .claude/skills/check-broken-links/run.ts \
     --repo-root repos/<owner>/<repo> \
     --repo-name <repo> \
     --state-file state/repos/<owner>-<repo>.json \
     --tracking-issue-state <open|closed|absent> \
     --plan-out /tmp/plan-<owner>-<repo>.json \
     --body-out /tmp/body-<owner>-<repo>.md
   ```

4. Read the plan JSON at `--plan-out` and execute its `kind`:
   - `none` — do nothing.
   - `open` — `gh issue create --repo <owner>/<repo> --title "<plan.title>" --body-file <plan.bodyFile>`. Capture the new issue number `n` from the URL, then patch the state file: set `trackingIssueNumber` to `n` in `state/repos/<owner>-<repo>.json`.
   - `update` — `gh issue edit <plan.issueNumber> --repo <owner>/<repo> --body-file <plan.bodyFile>`.
   - `close` — `gh issue close <plan.issueNumber> --repo <owner>/<repo> --comment "<plan.comment>"`.

   The wrapper has already written the next state for you, except for the `trackingIssueNumber` patch in the `open` case (deliberate — written only after `gh issue create` succeeds, so a failed call leaves the state recoverable).

## Issue title and body format

Title: `[Bug]: broken links in <repo>`. The wrapper composes this from `--repo-name`. Keep the format stable so humans recognise it at a glance.

Body (rendered by `renderIssueBody` in `render.ts`, written to `--body-out`): a markdown checklist, one bullet per broken link, grouped by file, files sorted alphabetically and lines numerically. Example:

```markdown
dam-bot found broken links in this repo's documentation. Each link below has been broken on at least two consecutive runs.

Close this issue once the links are fixed (or if you've decided they're not worth fixing) and dam-bot will stop reporting them.

## `README.md`

- [ ] Line 15: `https://flaky.example.com` (connection refused)

## `docs/index.md`

- [ ] Line 42: `https://example.com/gone` (HTTP 404)
- [ ] Line 87: `./missing.md` (file not found)
```

## Error handling

- If `gh repo clone` or `git pull` fails for a repo, log the error, skip that repo, and continue with the next. Do not delete the local state.
- If the wrapper itself throws (bad clone, malformed state file, etc.), log and skip that repo. State is left as it was on disk before the wrapper ran.
- If a `gh issue create/edit/close` call fails *after* the wrapper succeeded, log the error and continue. The wrapper has already advanced `state/repos/<owner>-<repo>.json`, but reconciliation is idempotent over the same findings, so the next run will produce the same action and retry. Exception: for a failed `open`, do not patch `trackingIssueNumber` — without it, the next run will treat the issue as `absent` and try `open` again.

## Guardrails

- Never push to target repos. Never create branches. Never open pull requests. dam-bot's token is deliberately scoped so these would fail anyway; don't attempt them.
- Do not alter files under `./repos/<owner>/<repo>/` beyond what `git pull` does.
- Do not spawn long-running processes. Each run should complete in a single sweep.

## When to ask the user (beyond onboarding)

- If the user replies on a tracking issue saying a given domain should be ignored ("ignore flaky.example.com, it rotates IPs"), note the rule in `MEMORY.md` under `## Ignore rules`. Next run, pass a matching regex in `skipPatterns` to `checkLinks`.
- This `MEMORY.md`-based learning is the only way new ignore rules enter the system. Do not edit `SKILL.md` or code to add ignore rules.
