/**
 * CLI wrapper: full sweep for one repo.
 *
 * Reads the prior per-repo state, runs the link checker, reconciles against
 * the tracking issue's known state, persists the next state, renders an issue
 * body if needed, and emits an action plan for the caller to execute via gh.
 *
 * Usage:
 *   npx tsx .claude/skills/check-broken-links/run.ts \
 *     --repo-root <path> \
 *     --state-file <path> \
 *     --tracking-issue-state <open|closed|absent> \
 *     --plan-out <path> \
 *     --body-out <path> \
 *     [--skip-patterns-file <path>]
 *
 * --skip-patterns-file is optional: a text file with one regex per line; blank
 * lines and lines starting with `#` are ignored. Each pattern is compiled as a
 * JavaScript RegExp and passed to checkLinks as skipPatterns.
 *
 * Side effects:
 *   - Overwrites <state-file> with the next state. For the "open" action this
 *     is written WITHOUT trackingIssueNumber; the caller patches that in after
 *     `gh issue create` succeeds, so a failed gh call leaves state recoverable.
 *   - Writes <body-out> with rendered markdown only for open/update actions.
 *   - Writes <plan-out> with the action the caller must execute.
 */
import { readFile, writeFile } from "node:fs/promises";
import { checkLinks } from "./check-links.js";
import {
  initialState,
  reconcileState,
  type KnownBroken,
  type State,
  type TrackingIssueState,
} from "./reconcile-state.js";

const ISSUE_TITLE = "[Bug]: broken links";

const ISSUE_PREAMBLE =
  "link-guardian found broken links in this repo's documentation. Each link below has been broken on at least two consecutive runs.\n\n" +
  "Close this issue once the links are fixed (or if you've decided they're not worth fixing) and link-guardian will stop reporting them.";

const COLLAPSE_THRESHOLD = 5;

function renderIssueBody(items: KnownBroken[]): string {
  const byFile = new Map<string, KnownBroken[]>();
  for (const item of items) {
    const list = byFile.get(item.file) ?? [];
    list.push(item);
    byFile.set(item.file, list);
  }
  const sections = [...byFile.keys()].sort().map((file) => {
    const fileItems = byFile
      .get(file)!
      .slice()
      .sort((a, b) => a.line - b.line);
    const lines = fileItems.map(
      (it) => `- [ ] Line ${it.line}: \`${it.url}\` — ${it.reason}`,
    );
    const header = `**\`${file}\`** _(${fileItems.length} broken)_`;
    if (fileItems.length > COLLAPSE_THRESHOLD) {
      return `<details>\n<summary>${header}</summary>\n\n${lines.join("\n")}\n</details>`;
    }
    return `${header}\n\n${lines.join("\n")}`;
  });
  return `${ISSUE_PREAMBLE}\n\n${sections.join("\n\n")}\n`;
}

interface Args {
  repoRoot: string;
  stateFile: string;
  trackingIssueState: TrackingIssueState;
  planOut: string;
  bodyOut: string;
  skipPatternsFile?: string;
}

export type Plan =
  | { kind: "none" }
  | { kind: "open"; title: string; bodyFile: string }
  | { kind: "update"; issueNumber: number; bodyFile: string }
  | { kind: "close"; issueNumber: number; comment: string };

const CLOSE_COMMENT =
  "All previously reported links now resolve. Closing.";

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repoRoot = get("--repo-root");
  const stateFile = get("--state-file");
  const trackingIssueState = get("--tracking-issue-state");
  const planOut = get("--plan-out");
  const bodyOut = get("--body-out");
  const skipPatternsFile = get("--skip-patterns-file");
  if (
    !repoRoot ||
    !stateFile ||
    !trackingIssueState ||
    !planOut ||
    !bodyOut
  ) {
    throw new Error(
      "usage: run.ts --repo-root <path> --state-file <path> --tracking-issue-state <open|closed|absent> --plan-out <path> --body-out <path> [--skip-patterns-file <path>]",
    );
  }
  if (
    trackingIssueState !== "open" &&
    trackingIssueState !== "closed" &&
    trackingIssueState !== "absent"
  ) {
    throw new Error(
      `--tracking-issue-state must be open|closed|absent, got ${trackingIssueState}`,
    );
  }
  return {
    repoRoot,
    stateFile,
    trackingIssueState,
    planOut,
    bodyOut,
    ...(skipPatternsFile && { skipPatternsFile }),
  };
}

async function readState(path: string): Promise<State> {
  try {
    const buf = await readFile(path, "utf8");
    return JSON.parse(buf) as State;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return initialState();
    }
    throw err;
  }
}

async function readSkipPatterns(path: string): Promise<RegExp[]> {
  const buf = await readFile(path, "utf8");
  return buf
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => new RegExp(line));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prevState = await readState(args.stateFile);
  const skipPatterns = args.skipPatternsFile
    ? await readSkipPatterns(args.skipPatternsFile)
    : [];
  const findings = await checkLinks({
    repoRoot: args.repoRoot,
    skipPatterns,
  });
  const { nextState, action } = reconcileState({
    prevState,
    findings,
    trackingIssueState: args.trackingIssueState,
  });

  await writeFile(args.stateFile, JSON.stringify(nextState, null, 2));

  let plan: Plan;
  if (action.kind === "open") {
    await writeFile(args.bodyOut, renderIssueBody(action.items));
    plan = {
      kind: "open",
      title: ISSUE_TITLE,
      bodyFile: args.bodyOut,
    };
  } else if (action.kind === "update") {
    await writeFile(args.bodyOut, renderIssueBody(action.items));
    plan = {
      kind: "update",
      issueNumber: action.issueNumber,
      bodyFile: args.bodyOut,
    };
  } else if (action.kind === "close") {
    plan = {
      kind: "close",
      issueNumber: action.issueNumber,
      comment: CLOSE_COMMENT,
    };
  } else {
    plan = { kind: "none" };
  }

  await writeFile(args.planOut, JSON.stringify(plan, null, 2));
  console.log(`action=${plan.kind} state=${args.stateFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
