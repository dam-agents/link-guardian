/**
 * Pure rendering helpers for the broken-link tracking issue.
 *
 * Separated from run.ts so tests can import without triggering the CLI entry.
 */
import type { KnownBroken } from "./reconcile-state.js";

export function composeIssueTitle(repoName: string): string {
  return `[Bug]: broken links in ${repoName}`;
}

export function renderIssueBody(items: KnownBroken[]): string {
  const byFile = new Map<string, KnownBroken[]>();
  for (const item of items) {
    const list = byFile.get(item.file) ?? [];
    list.push(item);
    byFile.set(item.file, list);
  }

  const sections = [...byFile.keys()]
    .sort()
    .map((file) => {
      const lines = byFile
        .get(file)!
        .slice()
        .sort((a, b) => a.line - b.line)
        .map((it) => `- [ ] Line ${it.line}: \`${it.url}\` (${it.reason})`);
      return `## \`${file}\`\n\n${lines.join("\n")}`;
    });

  const preamble =
    "dam-bot found broken links in this repo's documentation. Each link below has been broken on at least two consecutive runs.\n\n" +
    "Close this issue once the links are fixed (or if you've decided they're not worth fixing) and dam-bot will stop reporting them.";

  return `${preamble}\n\n${sections.join("\n\n")}\n`;
}
