---
name: check-broken-links
description: Walk markdown in configured repos, classify broken external and relative links, maintain one tracking issue per repo.
---

# check-broken-links

You are running the broken-link-detection skill for humr-bot. Your job is to scan markdown files in each configured target repo, classify links that are broken, and keep exactly one tracking issue per repo up to date with what needs fixing.

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

2. Run the link checker:
   ```
   pnpm exec tsx .claude/skills/check-broken-links/run.ts \
     --repo-root repos/<owner>/<repo> \
     --out /tmp/findings-<owner>-<repo>.json
   ```
   The wrapper writes the `BrokenLink[]` JSON to `--out`. Reconciliation is the next step (below) and runs in-conversation against `state/repos/<owner>-<repo>.json`.

3. Determine the tracking issue's current state:
   - If `state/repos/<owner>-<repo>.json` contains a `trackingIssueNumber`, query `gh issue view <n> --repo <owner>/<repo> --json state` to learn whether it is open or closed.
   - Otherwise, the state is `absent`.

4. Call `reconcileState` with `{ prevState, findings, trackingIssueState }`. It returns `{ nextState, action }`.

5. Execute the action:
   - `none` — do nothing.
   - `open` — create a new issue in the target repo with the body composed from `items` (see "Issue body format" below). Record the returned issue number into `nextState.trackingIssueNumber`.
   - `update` — rewrite the body of `issueNumber` with the new item list. Use `gh issue edit <n> --repo <owner>/<repo> --body-file <file>`.
   - `close` — `gh issue close <n> --repo <owner>/<repo> --comment "All previously reported links now resolve. Closing."`

6. Persist `nextState` to `state/repos/<owner>-<repo>.json`.

## Issue body format

The body is a markdown checklist, one bullet per broken link, grouped by file. Example:

```markdown
humr-bot found broken links in this repo's documentation. Each link below has been broken on at least two consecutive runs.

Close this issue once the links are fixed (or if you've decided they're not worth fixing) and humr-bot will stop reporting them.

## `docs/index.md`

- [ ] Line 42: `https://example.com/gone` (HTTP 404)
- [ ] Line 87: `./missing.md` (file not found: ./missing.md)

## `README.md`

- [ ] Line 15: `https://flaky.example.com` (connection refused)
```

Use the issue title `[humr-bot] Broken links in <repo>` so the human recognises it at a glance and so you can find it again if state is lost.

## Error handling

- If `gh repo clone` or `git pull` fails for a repo, log the error, skip that repo, and continue with the next. Do not delete the local state.
- If `gh issue create/edit/close` fails, log the error and leave `state/repos/<owner>-<repo>.json` unchanged for that repo so the action is retried next run.
- If `checkLinks` throws, stop that repo (same policy as above).

## Guardrails

- Never push to target repos. Never create branches. Never open pull requests. humr-bot's token is deliberately scoped so these would fail anyway; don't attempt them.
- Do not alter files under `./repos/<owner>/<repo>/` beyond what `git pull` does.
- Do not spawn long-running processes. Each run should complete in a single sweep.

## When to ask the user (beyond onboarding)

- If the user replies on a tracking issue saying a given domain should be ignored ("ignore flaky.example.com, it rotates IPs"), note the rule in `MEMORY.md` under `## Ignore rules`. Next run, pass a matching regex in `skipPatterns` to `checkLinks`.
- This `MEMORY.md`-based learning is the only way new ignore rules enter the system. Do not edit `SKILL.md` or code to add ignore rules.
