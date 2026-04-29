/**
 * CLI wrapper around checkLinks.
 *
 * Usage:
 *   pnpm exec tsx .claude/skills/check-broken-links/run.ts \
 *     --repo-root <path> \
 *     --out <findings.json>
 *
 * Writes the BrokenLink[] result as JSON to --out. Reconciliation against
 * the per-repo state file is the caller's responsibility (see SKILL.md).
 */
import { writeFile } from "node:fs/promises";
import { checkLinks } from "./check-links.js";

interface Args {
  repoRoot: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repoRoot = get("--repo-root");
  const out = get("--out");
  if (!repoRoot || !out) {
    throw new Error("usage: run.ts --repo-root <path> --out <file>");
  }
  return { repoRoot, out };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const findings = await checkLinks({ repoRoot: args.repoRoot });
  await writeFile(args.out, JSON.stringify(findings, null, 2));
  console.log(`wrote ${findings.length} finding(s) to ${args.out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
