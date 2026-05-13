/**
 * Pure state reconciliation for the broken-link-detection run loop.
 *
 * Given the previous per-repo state and this run's findings, compute the next
 * state and the action the caller should take against the tracking issue.
 *
 * The caller is responsible for:
 *   - Reading the previous state from disk and passing it in.
 *   - Querying GitHub for the tracking issue's current state and passing it in
 *     as `trackingIssueState`.
 *   - Executing the returned action (opening, updating, or closing an issue).
 *   - If the action was `open`, writing the returned issue number into
 *     `nextState.trackingIssueNumber` before persisting.
 *
 * Debounce rule: a finding is promoted to `toReport` only after it has been
 * present on ≥2 consecutive runs. First detections are silent. When the human
 * closes the tracking issue, debounce state resets and next reports start fresh.
 */

export interface Finding {
  url: string;
  file: string;
  line: number;
  kind: "absolute" | "relative";
  reason: string;
  status?: number;
}

export interface KnownBroken extends Finding {
  firstSeenRun: number;
  reportedInRun?: number;
}

export interface State {
  runCount: number;
  trackingIssueNumber?: number;
  // Issue number whose closure triggered the last debounce reset. The run loop
  // checks this to avoid re-firing the reset on every subsequent scan of the
  // same permanently-closed issue.
  lastProcessedClosedIssueNumber?: number;
  knownBroken: Record<string, KnownBroken>;
}

export type TrackingIssueState = "open" | "closed" | "absent";

export type Action =
  | { kind: "none" }
  | { kind: "open"; items: KnownBroken[] }
  | { kind: "update"; issueNumber: number; items: KnownBroken[] }
  | { kind: "close"; issueNumber: number };

export interface ReconcileInput {
  prevState: State;
  findings: Finding[];
  trackingIssueState: TrackingIssueState;
}

export interface ReconcileOutput {
  nextState: State;
  action: Action;
}

export function initialState(): State {
  return { runCount: 0, knownBroken: {} };
}

// State entries are keyed by url + file so the same broken URL can be tracked
// independently in multiple files within a repo. Line number is deliberately
// excluded so minor edits above a link don't reset debounce.
export function keyFor(f: Pick<Finding, "url" | "file">): string {
  return `${f.url}\t${f.file}`;
}

export function reconcileState(input: ReconcileInput): ReconcileOutput {
  const { findings, trackingIssueState, prevState } = input;

  let prevKnown = prevState.knownBroken;
  let trackingIssueNumber = prevState.trackingIssueNumber;

  // Human closed the issue: accept and start fresh.
  if (trackingIssueState === "closed") {
    prevKnown = {};
    trackingIssueNumber = undefined;
  }

  const runCount = prevState.runCount + 1;
  const nextKnown: Record<string, KnownBroken> = {};
  const reported: KnownBroken[] = [];

  for (const finding of findings) {
    const key = keyFor(finding);
    const prev = prevKnown[key];
    if (prev !== undefined) {
      const entry: KnownBroken = {
        ...finding,
        firstSeenRun: prev.firstSeenRun,
        reportedInRun: prev.reportedInRun ?? runCount,
      };
      nextKnown[key] = entry;
      reported.push(entry);
    } else {
      nextKnown[key] = { ...finding, firstSeenRun: runCount };
    }
  }

  const { lastProcessedClosedIssueNumber } = prevState;
  const nextState: State = {
    runCount,
    knownBroken: nextKnown,
    ...(trackingIssueNumber !== undefined && { trackingIssueNumber }),
    ...(lastProcessedClosedIssueNumber !== undefined && {
      lastProcessedClosedIssueNumber,
    }),
  };

  let action: Action;
  if (reported.length > 0) {
    if (trackingIssueState === "open" && trackingIssueNumber !== undefined) {
      action = {
        kind: "update",
        issueNumber: trackingIssueNumber,
        items: reported,
      };
    } else {
      action = { kind: "open", items: reported };
    }
  } else if (trackingIssueState === "open" && trackingIssueNumber !== undefined) {
    action = { kind: "close", issueNumber: trackingIssueNumber };
  } else {
    action = { kind: "none" };
  }

  return { nextState, action };
}
