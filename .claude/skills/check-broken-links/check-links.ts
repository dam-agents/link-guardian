/**
 * Deterministic link checker for a cloned repository.
 *
 * Exports pure helpers (extractLinks, shouldSkipUrl, classifyRelative) plus the
 * top-level `checkLinks(options)` orchestrator. HTTP transport is injected so
 * tests can run without the network.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

// ---------- Public types ----------

export interface BrokenLink {
  file: string;
  line: number;
  url: string;
  kind: "absolute" | "relative";
  reason: string;
  status?: number;
}

export type HttpClient = (
  url: string,
  init: { method: "HEAD" | "GET"; signal: AbortSignal },
) => Promise<Response>;

export interface CheckLinksOptions {
  repoRoot: string;
  http?: HttpClient;
  timeoutMs?: number;
  retries?: number;
  maxRedirects?: number;
  skipPatterns?: RegExp[];
}

// ---------- Link extraction ----------

export interface ExtractedLink {
  url: string;
  line: number;
}

const FENCE = /^(```|~~~)/;
const INLINE_CODE = /`[^`\n]*`/g;
const REF_DEF = /^\s*\[([^\]]+)\]:\s*<?([^\s>]+)>?/;
const INLINE_LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const AUTOLINK = /<((?:https?|ftp):\/\/[^>\s]+)>/g;
const REF_LINK = /\[([^\]]+)\]\[([^\]]*)\]/g;

export function extractLinks(markdown: string): ExtractedLink[] {
  const lines = markdown.split(/\r?\n/);
  const refs = new Map<string, string>();
  const found: ExtractedLink[] = [];
  const refUses: Array<{ ref: string; line: number }> = [];

  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (FENCE.test(raw.trimStart())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const line = raw.replace(INLINE_CODE, "");

    const def = REF_DEF.exec(line);
    if (def) {
      refs.set(def[1]!.toLowerCase(), def[2]!);
      continue;
    }

    for (const m of line.matchAll(INLINE_LINK)) {
      found.push({ url: m[1]!, line: i + 1 });
    }
    for (const m of line.matchAll(AUTOLINK)) {
      found.push({ url: m[1]!, line: i + 1 });
    }
    for (const m of line.matchAll(REF_LINK)) {
      const ref = (m[2] || m[1])!;
      refUses.push({ ref, line: i + 1 });
    }
  }

  for (const use of refUses) {
    const url = refs.get(use.ref.toLowerCase());
    if (url) found.push({ url, line: use.line });
  }

  return found;
}

// ---------- Skip rules ----------

const PRIVATE_HOST = [
  /^localhost$/i,
  /^127\./,
  /^::1$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /\.internal$/i,
  /\.local$/i,
];

export function shouldSkipUrl(url: string, extra: RegExp[] = []): boolean {
  if (url.startsWith("#")) return true;
  if (/^(mailto|tel|file|javascript|data):/i.test(url)) return true;

  if (/^https?:\/\//i.test(url)) {
    try {
      const host = new URL(url).hostname;
      if (PRIVATE_HOST.some((re) => re.test(host))) return true;
    } catch {
      // Malformed URL — let classification surface it as broken.
    }
  }

  return extra.some((re) => re.test(url));
}

// ---------- Absolute link classification ----------

export interface ClassifyResult {
  ok: boolean;
  reason: string;
  status?: number;
}

type Outcome =
  | { kind: "terminal"; ok: boolean; reason: string; status?: number }
  | { kind: "redirect"; to: string; status: number }
  | { kind: "error"; reason: string };

async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error(`timeout after ${ms}ms`)),
    ms,
  );
  timer.unref?.();
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function performRequest(
  url: string,
  http: HttpClient,
  opts: { timeoutMs: number; retries: number },
): Promise<Outcome> {
  let lastError: string | undefined;

  for (const method of ["HEAD", "GET"] as const) {
    for (let attempt = 0; attempt <= opts.retries; attempt++) {
      let res: Response;
      try {
        res = await withTimeout(
          (signal) => http(url, { method, signal }),
          opts.timeoutMs,
        );
      } catch (err) {
        lastError = (err as Error).message;
        continue;
      }

      if (
        method === "HEAD" &&
        (res.status === 405 || res.status === 403 || res.status === 501)
      ) {
        break; // fall through to GET
      }

      if (res.status >= 500 && attempt < opts.retries) continue;

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) {
          return {
            kind: "terminal",
            ok: false,
            reason: `HTTP ${res.status} without Location`,
            status: res.status,
          };
        }
        return {
          kind: "redirect",
          to: new URL(loc, url).toString(),
          status: res.status,
        };
      }

      if (res.status >= 400 && res.status !== 429) {
        return {
          kind: "terminal",
          ok: false,
          reason: `HTTP ${res.status}`,
          status: res.status,
        };
      }

      return {
        kind: "terminal",
        ok: true,
        reason: `HTTP ${res.status}`,
        status: res.status,
      };
    }
  }

  return { kind: "error", reason: lastError ?? "network error" };
}

export async function classifyAbsolute(
  url: string,
  http: HttpClient,
  opts: { timeoutMs: number; retries: number; maxRedirects: number },
): Promise<ClassifyResult> {
  let current = url;
  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    const outcome = await performRequest(current, http, opts);
    if (outcome.kind === "terminal") {
      return {
        ok: outcome.ok,
        reason: outcome.reason,
        ...(outcome.status !== undefined && { status: outcome.status }),
      };
    }
    if (outcome.kind === "error") {
      return { ok: false, reason: outcome.reason };
    }
    current = outcome.to;
  }
  return {
    ok: false,
    reason: `too many redirects (>${opts.maxRedirects})`,
  };
}

// ---------- Relative link classification ----------

export async function classifyRelative(
  url: string,
  fromFile: string,
  repoRoot: string,
): Promise<ClassifyResult> {
  const [path] = url.split("#");
  if (!path) return { ok: true, reason: "fragment only" };

  const target = path.startsWith("/")
    ? resolve(repoRoot, path.slice(1))
    : isAbsolute(path)
      ? path
      : resolve(dirname(fromFile), path);

  try {
    await stat(target);
    return { ok: true, reason: "file exists" };
  } catch {
    return { ok: false, reason: `file not found: ${path}` };
  }
}

// ---------- File discovery ----------

async function findMarkdownFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) results.push(full);
    }
  }
  await walk(root);
  return results;
}

// ---------- Default HTTP client ----------

export const defaultHttpClient: HttpClient = (url, { method, signal }) =>
  fetch(url, { method, signal, redirect: "manual" });

// ---------- Orchestrator ----------

export async function checkLinks(
  options: CheckLinksOptions,
): Promise<BrokenLink[]> {
  const {
    repoRoot,
    http = defaultHttpClient,
    timeoutMs = 10_000,
    retries = 1,
    maxRedirects = 5,
    skipPatterns = [],
  } = options;

  const files = await findMarkdownFiles(repoRoot);
  const broken: BrokenLink[] = [];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    const links = extractLinks(content);
    for (const link of links) {
      if (shouldSkipUrl(link.url, skipPatterns)) continue;

      const isAbsoluteUrl = /^https?:\/\//i.test(link.url);
      const kind: "absolute" | "relative" = isAbsoluteUrl
        ? "absolute"
        : "relative";
      const result = isAbsoluteUrl
        ? await classifyAbsolute(link.url, http, {
            timeoutMs,
            retries,
            maxRedirects,
          })
        : await classifyRelative(link.url, file, repoRoot);

      if (!result.ok) {
        broken.push({
          file: relative(repoRoot, file),
          line: link.line,
          url: link.url,
          kind,
          reason: result.reason,
          ...(result.status !== undefined && { status: result.status }),
        });
      }
    }
  }

  return broken;
}
