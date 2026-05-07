/**
 * CLI wrapper: full sweep for one repo.
 *
 * Reads the prior per-repo state, runs the link checker, reconciles against
 * the tracking issue's known state, persists the next state, renders an issue
 * body if needed, and emits an action plan for the caller to execute via gh.
 *
 * Usage:
 *   pnpm exec tsx .claude/skills/check-broken-links/run.ts \
 *     --repo-root <path> \
 *     --repo-name <name> \
 *     --state-file <path> \
 *     --tracking-issue-state <open|closed|absent> \
 *     --plan-out <path> \
 *     --body-out <path>
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
  type State,
  type TrackingIssueState,
} from "./reconcile-state.js";
import { composeIssueTitle, renderIssueBody } from "./render.js";

interface Args {
  repoRoot: string;
  repoName: string;
  stateFile: string;
  trackingIssueState: TrackingIssueState;
  planOut: string;
  bodyOut: string;
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
  const repoName = get("--repo-name");
  const stateFile = get("--state-file");
  const trackingIssueState = get("--tracking-issue-state");
  const planOut = get("--plan-out");
  const bodyOut = get("--body-out");
  if (
    !repoRoot ||
    !repoName ||
    !stateFile ||
    !trackingIssueState ||
    !planOut ||
    !bodyOut
  ) {
    throw new Error(
      "usage: run.ts --repo-root <path> --repo-name <name> --state-file <path> --tracking-issue-state <open|closed|absent> --plan-out <path> --body-out <path>",
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
    repoName,
    stateFile,
    trackingIssueState,
    planOut,
    bodyOut,
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prevState = await readState(args.stateFile);
  const findings = await checkLinks({ repoRoot: args.repoRoot });
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
      title: composeIssueTitle(args.repoName),
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
