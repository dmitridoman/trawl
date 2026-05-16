import type { SecurityHeaders } from "./util";

type Check = { name: string; required: boolean; weight: number; validate?: (v: string) => boolean | string };

const CHECKS: Check[] = [
  { name: "strict-transport-security", required: true, weight: 20 },
  { name: "content-security-policy", required: true, weight: 25 },
  { name: "x-content-type-options", required: true, weight: 10, validate: (v) => /^nosniff$/i.test(v) || "should be 'nosniff'" },
  { name: "x-frame-options", required: false, weight: 10 },
  { name: "referrer-policy", required: true, weight: 15 },
  { name: "permissions-policy", required: false, weight: 10 },
  { name: "cross-origin-opener-policy", required: false, weight: 5 },
  { name: "cross-origin-resource-policy", required: false, weight: 5 },
];

const TOTAL_WEIGHT = CHECKS.reduce((s, c) => s + c.weight, 0);

export function scoreHeaders(status: number | null, headers: Record<string, string>): SecurityHeaders {
  const normalised: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) normalised[k.toLowerCase()] = v;

  let earned = 0;
  const checks: SecurityHeaders["checks"] = [];

  for (const c of CHECKS) {
    const value = normalised[c.name] ?? null;
    let present = value !== null;
    let note: string | undefined;

    if (present && c.validate && value) {
      const ok = c.validate(value);
      if (ok !== true) {
        note = typeof ok === "string" ? ok : "invalid value";
        present = false;
      }
    }

    if (present) earned += c.weight;
    checks.push({ name: c.name, present, value, note });
  }

  const score = Math.round((earned / TOTAL_WEIGHT) * 100);
  const grade: SecurityHeaders["grade"] = score >= 90 ? "A" : score >= 75 ? "B" : score >= 55 ? "C" : score >= 35 ? "D" : "F";

  return { status, score, grade, checks };
}
