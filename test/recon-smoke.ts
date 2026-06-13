// Standalone smoke test for the passive-recon modules. Run with:
//   node test/recon-smoke.ts
// (Node 22+ strips the TS types; no build needed.)
import { detectTech, rollupTech, type TechInput } from "../src/tech.ts";
import { correlateVulnerabilities } from "../src/cve.ts";
import { lookupDomain, lookupDns, lookupGeo, checkEmailSecurity } from "../src/domain.ts";
import { inspectTls } from "../src/tls.ts";

async function fetchPage(url: string): Promise<TechInput> {
  const res = await fetch(url, { redirect: "follow" });
  const html = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  const scriptSrc = Array.from(html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)).map((m) => m[1]!);
  const metas: Record<string, string> = {};
  for (const m of html.matchAll(/<meta[^>]+>/gi)) {
    const tag = m[0]!;
    const name = /(?:name|property)=["']([^"']+)["']/i.exec(tag)?.[1];
    const content = /content=["']([^"']*)["']/i.exec(tag)?.[1];
    if (name && content !== undefined) metas[name.toLowerCase()] = content;
  }
  return { url, headers, cookies: [], html, scriptSrc, metas, jsGlobals: {} };
}

async function main() {
  console.log("\n=== 1. Tech fingerprinting (headers/html/scriptSrc/meta only — no JS globals) ===");
  for (const url of ["https://wordpress.org/", "https://www.bbc.co.uk/"]) {
    try {
      const input = await fetchPage(url);
      const result = detectTech(input);
      console.log(`\n${url} -> ${result.technologies.length} technologies`);
      for (const t of result.technologies.slice(0, 18)) {
        console.log(`   • ${t.name}${t.version ? ` ${t.version}` : ""}  [${t.categories.join(", ")}]  (conf ${t.confidence})`);
      }
    } catch (e) {
      console.log(`   fetch failed: ${(e as Error).message}`);
    }
  }

  console.log("\n=== 2. RetireJS CVE correlation (deterministic: jQuery 1.7.0 + Bootstrap 3.3.0) ===");
  const synthetic = rollupTech([
    { technologies: [
      { name: "jQuery", version: "1.7.0", confidence: 100, categories: ["JavaScript libraries"] },
      { name: "Bootstrap", version: "3.3.0", confidence: 100, categories: ["UI frameworks"] },
      { name: "jQuery", version: "3.7.1", confidence: 100, categories: ["JavaScript libraries"] }, // current — should NOT flag
    ] },
  ]);
  const vulns = await correlateVulnerabilities(synthetic, { nvd: false });
  console.log(`   ${vulns.length} findings:`);
  for (const v of vulns.slice(0, 12)) {
    console.log(`   • [${v.severity}] ${v.component} ${v.version} — ${v.ids.join(", ")} — ${v.summary.slice(0, 70)}`);
  }

  console.log("\n=== 3. Domain / DNS / Geo / Email (bbc.co.uk — exercises two-label suffix) ===");
  const host = "www.bbc.co.uk";
  const dnsRec = await lookupDns(host);
  console.log("   DNS A:", dnsRec.a, "| NS host:", dnsRec.dnsHost, "| mail:", dnsRec.mailProvider);
  const dom = await lookupDomain(host);
  console.log(`   Domain: ${dom.domain} | registrar: ${dom.registrar} | created: ${dom.createdAt} | age: ${dom.ageYears}y | source: ${dom.source}`);
  const geo = await lookupGeo(dnsRec.a[0]);
  console.log("   Geo:", geo ? `${geo.country} (${geo.countryCode}) · ${geo.isp} · ${geo.asn}` : "unavailable");
  const email = await checkEmailSecurity(host, dnsRec.txt);
  console.log(`   Email: grade ${email.grade} | spoofable: ${email.spoofable} | SPF ${email.spf.severity} | DMARC ${email.dmarc.severity} | DKIM ${email.dkim.severity}`);

  console.log("\n=== 4. TLS inspection (github.com) ===");
  const tlsInfo = await inspectTls("github.com");
  if (tlsInfo) {
    console.log(`   ok: ${tlsInfo.ok} | ${tlsInfo.protocol} | grade ${tlsInfo.grade} | issuer: ${tlsInfo.issuer} | expires in ${tlsInfo.daysToExpiry}d | legacy: ${tlsInfo.legacyProtocols.join(",") || "none"}`);
    for (const f of tlsInfo.findings) console.log(`      - [${f.severity}] ${f.name}: ${f.detail}`);
  }
  console.log("\nDone.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
