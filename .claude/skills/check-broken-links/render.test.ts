import { describe, expect, it } from "vitest";
import { composeIssueTitle, renderIssueBody } from "./render.js";
import type { KnownBroken } from "./reconcile-state.js";

function item(overrides: Partial<KnownBroken>): KnownBroken {
  return {
    url: "https://example.com",
    file: "README.md",
    line: 1,
    kind: "absolute",
    reason: "HTTP 404",
    status: 404,
    firstSeenRun: 1,
    reportedInRun: 2,
    ...overrides,
  };
}

describe("composeIssueTitle", () => {
  it("uses the [Bug]: prefix and the bare repo name", () => {
    expect(composeIssueTitle("dam-bot")).toBe("[Bug]: broken links in dam-bot");
  });
});

describe("renderIssueBody", () => {
  it("groups items by file and orders files alphabetically, lines numerically", () => {
    const body = renderIssueBody([
      item({ file: "README.md", line: 15, url: "https://flaky.example.com", reason: "connection refused" }),
      item({ file: "docs/index.md", line: 87, url: "./missing.md", kind: "relative", reason: "file not found" }),
      item({ file: "docs/index.md", line: 42, url: "https://example.com/gone", reason: "HTTP 404" }),
    ]);

    expect(body).toBe(
      "dam-bot found broken links in this repo's documentation. Each link below has been broken on at least two consecutive runs.\n\n" +
        "Close this issue once the links are fixed (or if you've decided they're not worth fixing) and dam-bot will stop reporting them.\n\n" +
        "## `README.md`\n\n" +
        "- [ ] Line 15: `https://flaky.example.com` (connection refused)\n\n" +
        "## `docs/index.md`\n\n" +
        "- [ ] Line 42: `https://example.com/gone` (HTTP 404)\n" +
        "- [ ] Line 87: `./missing.md` (file not found)\n",
    );
  });
});
