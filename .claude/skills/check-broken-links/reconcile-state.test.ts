import { describe, expect, it } from "vitest";
import {
  initialState,
  reconcileState,
  type Finding,
  type State,
} from "./reconcile-state.js";

function makeFinding(url: string, overrides: Partial<Finding> = {}): Finding {
  return {
    url,
    file: "README.md",
    line: 1,
    kind: url.startsWith("http") ? "absolute" : "relative",
    reason: "HTTP 404",
    status: 404,
    ...overrides,
  };
}

describe("reconcileState", () => {
  it("first detection is silent; state remembers firstSeenRun", () => {
    const { nextState, action } = reconcileState({
      prevState: initialState(),
      findings: [makeFinding("https://a.example.com")],
      trackingIssueState: "absent",
    });
    expect(action).toEqual({ kind: "none" });
    expect(nextState.runCount).toBe(1);
    expect(nextState.knownBroken["https://a.example.com"]?.firstSeenRun).toBe(1);
    expect(nextState.knownBroken["https://a.example.com"]?.reportedInRun).toBeUndefined();
  });

  it("second consecutive run with same finding opens an issue", () => {
    const run1 = reconcileState({
      prevState: initialState(),
      findings: [makeFinding("https://a.example.com")],
      trackingIssueState: "absent",
    });
    const run2 = reconcileState({
      prevState: run1.nextState,
      findings: [makeFinding("https://a.example.com")],
      trackingIssueState: "absent",
    });
    expect(run2.action.kind).toBe("open");
    if (run2.action.kind !== "open") throw new Error();
    expect(run2.action.items).toHaveLength(1);
    expect(run2.action.items[0]?.url).toBe("https://a.example.com");
    expect(run2.nextState.knownBroken["https://a.example.com"]?.reportedInRun).toBe(2);
  });

  it("subsequent run with existing open issue updates instead of opening", () => {
    let state: State = initialState();
    const finding = makeFinding("https://a.example.com");
    state = reconcileState({
      prevState: state,
      findings: [finding],
      trackingIssueState: "absent",
    }).nextState;
    state = reconcileState({
      prevState: state,
      findings: [finding],
      trackingIssueState: "absent",
    }).nextState;
    // Caller would have recorded issue number after 'open' action.
    state = { ...state, trackingIssueNumber: 42 };
    const run3 = reconcileState({
      prevState: state,
      findings: [finding],
      trackingIssueState: "open",
    });
    expect(run3.action).toMatchObject({ kind: "update", issueNumber: 42 });
  });

  it("drops findings that disappear (fixed or transient) silently", () => {
    let state: State = initialState();
    state = reconcileState({
      prevState: state,
      findings: [
        makeFinding("https://a.example.com"),
        makeFinding("https://b.example.com"),
      ],
      trackingIssueState: "absent",
    }).nextState;
    // b is gone on run 2 — should just disappear from state.
    const run2 = reconcileState({
      prevState: state,
      findings: [makeFinding("https://a.example.com")],
      trackingIssueState: "absent",
    });
    expect(Object.keys(run2.nextState.knownBroken)).toEqual(["https://a.example.com"]);
    // a was seen twice — promoted, so 'open' action with only a.
    expect(run2.action.kind).toBe("open");
    if (run2.action.kind !== "open") throw new Error();
    expect(run2.action.items).toHaveLength(1);
  });

  it("closes tracking issue when all previously reported links are fixed", () => {
    let state: State = initialState();
    const f = makeFinding("https://a.example.com");
    state = reconcileState({ prevState: state, findings: [f], trackingIssueState: "absent" }).nextState;
    state = reconcileState({ prevState: state, findings: [f], trackingIssueState: "absent" }).nextState;
    state = { ...state, trackingIssueNumber: 99 };
    const run3 = reconcileState({
      prevState: state,
      findings: [],
      trackingIssueState: "open",
    });
    expect(run3.action).toEqual({ kind: "close", issueNumber: 99 });
    expect(run3.nextState.knownBroken).toEqual({});
  });

  it("resets debounce when human closes the tracking issue", () => {
    let state: State = initialState();
    const f = makeFinding("https://a.example.com");
    state = reconcileState({ prevState: state, findings: [f], trackingIssueState: "absent" }).nextState;
    state = reconcileState({ prevState: state, findings: [f], trackingIssueState: "absent" }).nextState;
    state = { ...state, trackingIssueNumber: 7 };
    // Human closes issue between runs.
    const run3 = reconcileState({
      prevState: state,
      findings: [f],
      trackingIssueState: "closed",
    });
    // Reset: finding is treated as first-detection again; silent.
    expect(run3.action).toEqual({ kind: "none" });
    expect(run3.nextState.knownBroken["https://a.example.com"]?.firstSeenRun).toBe(3);
    expect(run3.nextState.knownBroken["https://a.example.com"]?.reportedInRun).toBeUndefined();
    expect(run3.nextState.trackingIssueNumber).toBeUndefined();
  });

  it("preserves reportedInRun across further runs for long-lived broken links", () => {
    let state: State = initialState();
    const f = makeFinding("https://a.example.com");
    state = reconcileState({ prevState: state, findings: [f], trackingIssueState: "absent" }).nextState;
    state = reconcileState({ prevState: state, findings: [f], trackingIssueState: "absent" }).nextState;
    state = { ...state, trackingIssueNumber: 5 };
    expect(state.knownBroken["https://a.example.com"]?.reportedInRun).toBe(2);
    state = reconcileState({
      prevState: state,
      findings: [f],
      trackingIssueState: "open",
    }).nextState;
    expect(state.knownBroken["https://a.example.com"]?.reportedInRun).toBe(2);
    expect(state.runCount).toBe(3);
  });

  it("updates file/line/reason for a known-broken link that moved", () => {
    let state: State = initialState();
    state = reconcileState({
      prevState: state,
      findings: [makeFinding("https://a.example.com", { file: "OLD.md", line: 10 })],
      trackingIssueState: "absent",
    }).nextState;
    const run2 = reconcileState({
      prevState: state,
      findings: [makeFinding("https://a.example.com", { file: "NEW.md", line: 99, reason: "HTTP 500" })],
      trackingIssueState: "absent",
    });
    if (run2.action.kind !== "open") throw new Error();
    expect(run2.action.items[0]?.file).toBe("NEW.md");
    expect(run2.action.items[0]?.line).toBe(99);
    expect(run2.action.items[0]?.reason).toBe("HTTP 500");
  });

  it("returns none when there are no findings and no tracking issue", () => {
    const r = reconcileState({
      prevState: initialState(),
      findings: [],
      trackingIssueState: "absent",
    });
    expect(r.action).toEqual({ kind: "none" });
  });
});
