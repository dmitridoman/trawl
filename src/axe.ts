import type { Page } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import path from "path";
import fs from "fs";
import type { AxeImpact, AxeSummary, AxeViolation } from "./util";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

export async function runAxe(page: Page, outDir: string, slug: string): Promise<AxeSummary> {
  const builder = new AxeBuilder({ page }).withTags(TAGS);
  const result = await builder.analyze();

  const violations: AxeViolation[] = result.violations.map((v) => {
    const firstNode = v.nodes[0];
    return {
      id: v.id,
      impact: (v.impact as AxeImpact | null) ?? null,
      help: v.help,
      helpUrl: v.helpUrl,
      wcag: v.tags.filter((t) => /^wcag\d/i.test(t)),
      nodes: v.nodes.length,
      sampleSelector: firstNode ? (Array.isArray(firstNode.target) ? firstNode.target.join(" ") : String(firstNode.target)) : null,
      sampleHtml: firstNode?.html ?? null,
    };
  });

  const byImpact: Record<AxeImpact, number> = { minor: 0, moderate: 0, serious: 0, critical: 0 };
  let nodeCount = 0;
  for (const v of violations) {
    if (v.impact) byImpact[v.impact] += v.nodes;
    nodeCount += v.nodes;
  }

  const summary: AxeSummary = {
    violationCount: violations.length,
    nodeCount,
    byImpact,
    violations,
  };

  const axeDir = path.join(outDir, "a11y");
  fs.mkdirSync(axeDir, { recursive: true });
  fs.writeFileSync(
    path.join(axeDir, `${slug}.json`),
    JSON.stringify({ slug, summary, raw: { violations: result.violations, incomplete: result.incomplete } }, null, 2),
  );

  return summary;
}
