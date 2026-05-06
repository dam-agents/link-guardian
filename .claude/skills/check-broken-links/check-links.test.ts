import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkLinks,
  classifyAbsolute,
  classifyRelative,
  extractLinks,
  shouldSkipUrl,
  type HttpClient,
} from "./check-links.js";

// ---------- extractLinks ----------

describe("extractLinks", () => {
  it("extracts inline links with line numbers", () => {
    const md = [
      "intro",
      "see [one](https://example.com/a) and [two](https://example.com/b)",
      "",
      "then [three](./local.md)",
    ].join("\n");
    expect(extractLinks(md)).toEqual([
      { url: "https://example.com/a", line: 2 },
      { url: "https://example.com/b", line: 2 },
      { url: "./local.md", line: 4 },
    ]);
  });

  it("extracts image links", () => {
    const md = "![alt](https://img.example.com/x.png)";
    expect(extractLinks(md)).toEqual([
      { url: "https://img.example.com/x.png", line: 1 },
    ]);
  });

  it("extracts autolinks", () => {
    const md = "see <https://example.com/auto>";
    expect(extractLinks(md)).toEqual([
      { url: "https://example.com/auto", line: 1 },
    ]);
  });

  it("resolves reference-style links", () => {
    const md = [
      "see [one][a] and [two][]",
      "",
      "[a]: https://example.com/ref-a",
      "[two]: https://example.com/ref-two",
    ].join("\n");
    const urls = extractLinks(md).map((l) => l.url).sort();
    expect(urls).toEqual([
      "https://example.com/ref-a",
      "https://example.com/ref-two",
    ]);
  });

  it("skips links inside fenced code blocks", () => {
    const md = [
      "pre [real](https://real.example.com)",
      "```",
      "ignored [fake](https://fake.example.com)",
      "```",
      "post [real2](https://real2.example.com)",
    ].join("\n");
    const urls = extractLinks(md).map((l) => l.url);
    expect(urls).toEqual([
      "https://real.example.com",
      "https://real2.example.com",
    ]);
  });

  it("strips inline code before matching", () => {
    const md = "see `[fake](https://fake.example.com)` and [real](https://real.example.com)";
    const urls = extractLinks(md).map((l) => l.url);
    expect(urls).toEqual(["https://real.example.com"]);
  });

  it("ignores unresolved reference-style links", () => {
    const md = "see [dangling][nope]";
    expect(extractLinks(md)).toEqual([]);
  });
});

// ---------- shouldSkipUrl ----------

describe("shouldSkipUrl", () => {
  it.each([
    ["#anchor", true],
    ["mailto:a@b.c", true],
    ["tel:+1234", true],
    ["file:///etc/passwd", true],
    ["http://localhost:3000", true],
    ["http://dam.localhost:4444", true],
    ["http://onecli.localhost:4444/path", true],
    ["http://127.0.0.1/api", true],
    ["https://10.0.0.5/x", true],
    ["https://192.168.1.1/x", true],
    ["https://172.16.0.1/x", true],
    ["https://172.31.0.1/x", true],
    ["https://svc.internal/x", true],
    ["https://host.local/x", true],
    ["https://example.com/a", false],
    ["./relative.md", false],
    ["https://172.15.0.1/x", false], // just below the RFC1918 block
    ["https://172.32.0.1/x", false], // just above the RFC1918 block
  ])("shouldSkipUrl(%s) === %s", (url, expected) => {
    expect(shouldSkipUrl(url)).toBe(expected);
  });

  it("honours extra patterns", () => {
    expect(shouldSkipUrl("https://flaky.example.com/x", [/flaky\.example\.com/])).toBe(true);
  });
});

// ---------- classifyAbsolute ----------

function fakeHttp(
  responses: Array<{
    url?: RegExp;
    method?: "HEAD" | "GET";
    response: Response | (() => Response | Promise<Response>) | Error;
  }>,
): { client: HttpClient; calls: Array<{ url: string; method: string }> } {
  const calls: Array<{ url: string; method: string }> = [];
  let idx = 0;
  const client: HttpClient = async (url, { method }) => {
    calls.push({ url, method });
    const entry = responses[idx++];
    if (!entry) throw new Error(`unexpected call #${idx} to ${method} ${url}`);
    if (entry.url && !entry.url.test(url)) {
      throw new Error(`unexpected url ${url}, wanted ${entry.url}`);
    }
    if (entry.method && entry.method !== method) {
      throw new Error(`unexpected method ${method}, wanted ${entry.method}`);
    }
    const r = entry.response;
    if (r instanceof Error) throw r;
    if (typeof r === "function") return r();
    return r;
  };
  return { client, calls };
}

describe("classifyAbsolute", () => {
  const opts = { timeoutMs: 1_000, retries: 1, maxRedirects: 5 };

  it("returns ok for 200", async () => {
    const { client } = fakeHttp([{ response: new Response(null, { status: 200 }) }]);
    const r = await classifyAbsolute("https://example.com", client, opts);
    expect(r).toEqual({ ok: true, reason: "HTTP 200", status: 200 });
  });

  it("returns broken for 404", async () => {
    const { client } = fakeHttp([{ response: new Response(null, { status: 404 }) }]);
    const r = await classifyAbsolute("https://example.com", client, opts);
    expect(r).toEqual({ ok: false, reason: "HTTP 404", status: 404 });
  });

  it("treats 429 as ok (transient)", async () => {
    const { client } = fakeHttp([{ response: new Response(null, { status: 429 }) }]);
    const r = await classifyAbsolute("https://example.com", client, opts);
    expect(r.ok).toBe(true);
  });

  it("retries 5xx once, then accepts success on retry", async () => {
    const { client, calls } = fakeHttp([
      { response: new Response(null, { status: 503 }) },
      { response: new Response(null, { status: 200 }) },
    ]);
    const r = await classifyAbsolute("https://example.com", client, opts);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("falls back to GET when HEAD returns 405", async () => {
    const { client, calls } = fakeHttp([
      { method: "HEAD", response: new Response(null, { status: 405 }) },
      { method: "GET", response: new Response(null, { status: 200 }) },
    ]);
    const r = await classifyAbsolute("https://example.com", client, opts);
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["HEAD", "GET"]);
  });

  it("follows redirects and reports final status", async () => {
    const { client } = fakeHttp([
      {
        response: new Response(null, {
          status: 301,
          headers: { location: "https://example.com/final" },
        }),
      },
      { response: new Response(null, { status: 200 }) },
    ]);
    const r = await classifyAbsolute("https://example.com/start", client, opts);
    expect(r.ok).toBe(true);
  });

  it("gives up after maxRedirects hops", async () => {
    const responses = Array.from({ length: 10 }, () => ({
      response: new Response(null, {
        status: 302,
        headers: { location: "https://example.com/loop" },
      }),
    }));
    const { client } = fakeHttp(responses);
    const r = await classifyAbsolute("https://example.com/loop", client, {
      ...opts,
      retries: 0,
      maxRedirects: 3,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/too many redirects/);
  });

  it("reports network errors after retries exhausted on both methods", async () => {
    const { client } = fakeHttp([
      { method: "HEAD", response: new Error("dns failure") },
      { method: "HEAD", response: new Error("dns failure") },
      { method: "GET", response: new Error("dns failure") },
      { method: "GET", response: new Error("dns failure") },
    ]);
    const r = await classifyAbsolute("https://dead.example.com", client, opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("dns failure");
  });

  it("reports broken when 5xx keeps failing after retry", async () => {
    const { client, calls } = fakeHttp([
      { response: new Response(null, { status: 503 }) },
      { response: new Response(null, { status: 503 }) },
    ]);
    const r = await classifyAbsolute("https://example.com", client, opts);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
    expect(calls).toHaveLength(2);
  });

  it("aborts after timeout and reports broken", async () => {
    const http: HttpClient = (_url, { signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const r = await classifyAbsolute("https://slow.example.com", http, {
      timeoutMs: 20,
      retries: 0,
      maxRedirects: 5,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/timeout/i);
  });

  it("treats redirect to a private host as broken (SSRF guard)", async () => {
    const { client } = fakeHttp([
      {
        response: new Response(null, {
          status: 301,
          headers: { location: "http://127.0.0.1/admin" },
        }),
      },
    ]);
    const r = await classifyAbsolute("https://external.example.com", client, opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/private or unsupported/);
  });
});

// ---------- classifyRelative + checkLinks (fixtures) ----------

describe("classifyRelative and checkLinks", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dam-bot-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("classifyRelative finds existing file next to source", async () => {
    await writeFile(join(root, "target.md"), "x");
    const from = join(root, "source.md");
    await writeFile(from, "y");
    const r = await classifyRelative("./target.md", from, root);
    expect(r.ok).toBe(true);
  });

  it("classifyRelative flags missing file", async () => {
    const from = join(root, "source.md");
    await writeFile(from, "x");
    const r = await classifyRelative("./missing.md", from, root);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/file not found/);
  });

  it("classifyRelative resolves /-prefixed path from repo root", async () => {
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs/guide.md"), "x");
    const from = join(root, "nested/source.md");
    await mkdir(join(root, "nested"));
    await writeFile(from, "y");
    const r = await classifyRelative("/docs/guide.md", from, root);
    expect(r.ok).toBe(true);
  });

  it("classifyRelative rejects paths that escape the repo root", async () => {
    const from = join(root, "sub/source.md");
    await mkdir(join(root, "sub"));
    await writeFile(from, "x");
    const r = await classifyRelative("../../../../etc/passwd", from, root);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/escapes repo root/);
  });

  it("checkLinks walks markdown, skips code fences, reports broken URLs and files", async () => {
    await writeFile(
      join(root, "README.md"),
      [
        "# t",
        "[good](https://good.example.com)",
        "[bad-url](https://bad.example.com)",
        "[bad-file](./nope.md)",
        "[skip](mailto:a@b.c)",
      ].join("\n"),
    );
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git/HEAD"), "should be ignored");

    const http: HttpClient = async (url) => {
      if (url.includes("good")) return new Response(null, { status: 200 });
      return new Response(null, { status: 404 });
    };

    const broken = await checkLinks({
      repoRoot: root,
      http,
      retries: 0,
      timeoutMs: 500,
    });

    expect(broken).toHaveLength(2);
    const urls = broken.map((b) => b.url).sort();
    expect(urls).toEqual(["./nope.md", "https://bad.example.com"]);
    const kinds = broken.map((b) => `${b.kind}:${b.url}`).sort();
    expect(kinds).toEqual([
      "absolute:https://bad.example.com",
      "relative:./nope.md",
    ]);
  });

  it("reports protocol-relative URLs as broken without fetching", async () => {
    await writeFile(
      join(root, "README.md"),
      "[x](//cdn.example.com/a.js)",
    );
    let fetched = false;
    const http: HttpClient = async () => {
      fetched = true;
      return new Response(null, { status: 200 });
    };
    const broken = await checkLinks({ repoRoot: root, http, retries: 0 });
    expect(fetched).toBe(false);
    expect(broken).toHaveLength(1);
    expect(broken[0]?.reason).toBe("URL missing scheme");
    expect(broken[0]?.kind).toBe("absolute");
  });
});
