import type { Page } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import path from "path";
import fs from "fs";
import { AXE_NODE_CAP, type AxeCheck, type AxeImpact, type AxeNode, type AxeSummary, type AxeViolation } from "./util";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

type RawAxeCheck = { id: string; message: string; data?: unknown };
type RawAxeNode = {
  target: unknown;
  html: string;
  failureSummary?: string;
  any?: RawAxeCheck[];
  all?: RawAxeCheck[];
  none?: RawAxeCheck[];
};

function targetToSelector(target: unknown): string {
  return Array.isArray(target) ? target.join(" ") : String(target ?? "");
}

function mapNode(n: RawAxeNode): AxeNode {
  const checks: AxeCheck[] = [...(n.any ?? []), ...(n.all ?? []), ...(n.none ?? [])].map((c) => ({
    id: c.id,
    message: c.message,
    data: c.data,
  }));
  return {
    target: targetToSelector(n.target),
    html: n.html,
    failureSummary: n.failureSummary ?? null,
    checks,
  };
}

export async function runAxe(page: Page, outDir: string, slug: string): Promise<AxeSummary> {
  const builder = new AxeBuilder({ page }).withTags(TAGS);
  const result = await builder.analyze();

  const violations: AxeViolation[] = result.violations.map((v) => {
    const allNodes = v.nodes as unknown as RawAxeNode[];
    return {
      id: v.id,
      impact: (v.impact as AxeImpact | null) ?? null,
      help: v.help,
      helpUrl: v.helpUrl,
      wcag: v.tags.filter((t) => /^wcag\d/i.test(t)),
      nodeCount: allNodes.length,
      nodes: allNodes.slice(0, AXE_NODE_CAP).map(mapNode),
      nodesTruncated: allNodes.length > AXE_NODE_CAP,
    };
  });

  const byImpact: Record<AxeImpact, number> = { minor: 0, moderate: 0, serious: 0, critical: 0 };
  let nodeCount = 0;
  for (const v of violations) {
    if (v.impact) byImpact[v.impact] += v.nodeCount;
    nodeCount += v.nodeCount;
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
