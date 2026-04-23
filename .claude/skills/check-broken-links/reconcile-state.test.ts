import { describe, expect, it } from "vitest";
import {
  initialState,
  keyFor,
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
    const f = makeFinding("https://a.example.com");
    const { nextState, action } = reconcileState({
      prevState: initialState(),
      findings: [f],
      trackingIssueState: "absent",
    });
    expect(action).toEqual({ kind: "none" });
    expect(nextState.runCount).toBe(1);
    const entry = nextState.knownBroken[keyFor(f)];
    expect(entry?.firstSeenRun).toBe(1);
    expect(entry?.reportedInRun).toBeUndefined();
  });

  it("second consecutive run with same finding opens an issue", () => {
    const f = makeFinding("https://a.example.com");
    const run1 = reconcileState({
      prevState: initialState(),
      findings: [f],
      trackingIssueState: "absent",
    });
    const run2 = reconcileState({
      prevState: run1.nextState,
      findings: [f],
      trackingIssueState: "absent",
    });
    expect(run2.action.kind).toBe("open");
    if (run2.action.kind !== "open") throw new Error();
    expect(run2.action.items).toHaveLength(1);
    expect(run2.action.items[0]?.url).toBe("https://a.example.com");
    expect(run2.nextState.knownBroken[keyFor(f)]?.reportedInRun).toBe(2);
  });

  it("updates issue (not opens new) and refreshes line/reason when issue is already open", () => {
    let state: State = initialState();
    state = reconcileState({
      prevState: state,
      findings: [makeFinding("https://a.example.com", { line: 10 })],
      trackingIssueState: "absent",
    }).nextState;
    state = reconcileState({
      prevState: state,
      findings: [makeFinding("https://a.example.com", { line: 10 })],
      trackingIssueState: "absent",
    }).nextState;
    state = { ...state, trackingIssueNumber: 42 };

    const run3 = reconcileState({
      prevState: state,
      findings: [makeFinding("https://a.example.com", { line: 99, reason: "HTTP 500" })],
      trackingIssueState: "open",
    });
    expect(run3.action.kind).toBe("update");
    if (run3.action.kind !== "update") throw new Error();
    expect(run3.action.issueNumber).toBe(42);
    expect(run3.action.items[0]?.line).toBe(99);
    expect(run3.action.items[0]?.reason).toBe("HTTP 500");
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
    const run2 = reconcileState({
      prevState: state,
      findings: [makeFinding("https://a.example.com")],
      trackingIssueState: "absent",
    });
    expect(Object.keys(run2.nextState.knownBroken)).toHaveLength(1);
    if (run2.action.kind !== "open") throw new Error();
    expect(run2.action.items).toHaveLength(1);
    expect(run2.action.items[0]?.url).toBe("https://a.example.com");
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
    const run3 = reconcileState({
      prevState: state,
      findings: [f],
      trackingIssueState: "closed",
    });
    expect(run3.action).toEqual({ kind: "none" });
    expect(run3.nextState.knownBroken[keyFor(f)]?.firstSeenRun).toBe(3);
    expect(run3.nextState.knownBroken[keyFor(f)]?.reportedInRun).toBeUndefined();
    expect(run3.nextState.trackingIssueNumber).toBeUndefined();
  });

  it("reports the same URL in two files as two items", () => {
    const inReadme = makeFinding("https://a.example.com", { file: "README.md" });
    const inGuide = makeFinding("https://a.example.com", { file: "docs/guide.md" });
    let state: State = initialState();
    state = reconcileState({
      prevState: state,
      findings: [inReadme, inGuide],
      trackingIssueState: "absent",
    }).nextState;
    const run2 = reconcileState({
      prevState: state,
      findings: [inReadme, inGuide],
      trackingIssueState: "absent",
    });
    if (run2.action.kind !== "open") throw new Error();
    expect(run2.action.items).toHaveLength(2);
    expect(run2.action.items.map((i) => i.file).sort()).toEqual([
      "README.md",
      "docs/guide.md",
    ]);
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
