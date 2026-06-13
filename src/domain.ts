import dns from "dns";
import type { DomainInfo, DnsRecords, GeoInfo, EmailSecurity, EmailFinding, ReconSeverity } from "./util";

const resolver = dns.promises;

// Passive only: RDAP is the modern JSON successor to WHOIS, DNS lookups read
// public records, ip-api returns public geo/ASN data, and email-security checks
// read the domain's own published TXT records. Nothing here probes the target.

async function fetchJson(url: string, accept: string, timeoutMs = 8000): Promise<any | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Accept: accept }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The registrable domain (drop sub-domains). Handles common two-label public
// suffixes (co.uk, com.au, …) so "www.shop.example.co.uk" -> "example.co.uk".
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk",
  "com.au", "net.au", "org.au", "co.nz", "co.za", "com.br", "co.jp", "co.in", "com.mx",
]);

export function registrableDomain(hostname: string): string {
  const host = hostname.replace(/\.$/, "").toLowerCase();
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join(".");
  const lastThree = labels.slice(-3).join(".");
  if (TWO_LABEL_SUFFIXES.has(lastTwo)) return lastThree;
  return lastTwo;
}

function vcardField(entity: any, field: string): string | null {
  const arr = entity?.vcardArray?.[1];
  if (!Array.isArray(arr)) return null;
  const row = arr.find((r: any) => Array.isArray(r) && r[0] === field);
  if (!row) return null;
  const val = row[3];
  if (typeof val === "string") return val;
  if (Array.isArray(val)) return val.filter(Boolean).join(", ");
  return null;
}

function findEntity(entities: any[], role: string): any | null {
  for (const e of entities ?? []) {
    if (Array.isArray(e.roles) && e.roles.includes(role)) return e;
    if (Array.isArray(e.entities)) {
      const nested = findEntity(e.entities, role);
      if (nested) return nested;
    }
  }
  return null;
}

function yearsSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.round(((Date.now() - then) / (365.25 * 24 * 3600 * 1000)) * 10) / 10;
}

export async function lookupDomain(hostname: string): Promise<DomainInfo> {
  const domain = registrableDomain(hostname);
  const empty: DomainInfo = {
    domain,
    registrar: null,
    createdAt: null,
    updatedAt: null,
    expiresAt: null,
    ageYears: null,
    nameservers: [],
    registrantOrg: null,
    registrantCountry: null,
    statuses: [],
    source: "unavailable",
  };

  const data = await fetchJson(`https://rdap.org/domain/${encodeURIComponent(domain)}`, "application/rdap+json");
  if (!data) return { ...empty, note: "RDAP unavailable for this TLD or domain" };

  const eventDate = (action: string): string | null => {
    const ev = (data.events ?? []).find((e: any) => e.eventAction === action);
    return ev?.eventDate ?? null;
  };

  const registrarEntity = findEntity(data.entities ?? [], "registrar");
  const registrantEntity = findEntity(data.entities ?? [], "registrant");
  const createdAt = eventDate("registration");

  return {
    domain,
    registrar: registrarEntity ? vcardField(registrarEntity, "fn") : null,
    createdAt,
    updatedAt: eventDate("last changed"),
    expiresAt: eventDate("expiration"),
    ageYears: yearsSince(createdAt),
    nameservers: (data.nameservers ?? []).map((n: any) => String(n.ldhName ?? "").toLowerCase()).filter(Boolean),
    registrantOrg: registrantEntity ? vcardField(registrantEntity, "org") || vcardField(registrantEntity, "fn") : null,
    registrantCountry: registrantEntity ? vcardField(registrantEntity, "adr") : null,
    statuses: Array.isArray(data.status) ? data.status : [],
    source: "rdap",
  };
}

function deriveMailProvider(mx: { exchange: string }[]): string | null {
  if (mx.length === 0) return null;
  const hosts = mx.map((m) => m.exchange.toLowerCase()).join(" ");
  if (/google|googlemail|aspmx/.test(hosts)) return "Google Workspace";
  if (/outlook|microsoft|office365|protection\.outlook/.test(hosts)) return "Microsoft 365";
  if (/protonmail|proton\.me/.test(hosts)) return "Proton Mail";
  if (/zoho/.test(hosts)) return "Zoho Mail";
  if (/mailgun/.test(hosts)) return "Mailgun";
  if (/sendgrid/.test(hosts)) return "SendGrid";
  if (/secureserver|godaddy/.test(hosts)) return "GoDaddy";
  if (/messagingengine|fastmail/.test(hosts)) return "Fastmail";
  if (/icloud|apple/.test(hosts)) return "iCloud Mail";
  return mx[0]!.exchange.replace(/\.$/, "");
}

function deriveDnsHost(ns: string[]): string | null {
  if (ns.length === 0) return null;
  const joined = ns.join(" ").toLowerCase();
  if (/cloudflare/.test(joined)) return "Cloudflare";
  if (/awsdns/.test(joined)) return "AWS Route 53";
  if (/googledomains|google/.test(joined)) return "Google";
  if (/azure-dns/.test(joined)) return "Azure DNS";
  if (/domaincontrol|godaddy/.test(joined)) return "GoDaddy";
  if (/nsone|ns1/.test(joined)) return "NS1";
  if (/dnsimple/.test(joined)) return "DNSimple";
  if (/digitalocean/.test(joined)) return "DigitalOcean";
  const parts = ns[0]!.replace(/\.$/, "").split(".");
  return parts.slice(-2).join(".");
}

export async function lookupDns(hostname: string): Promise<DnsRecords> {
  const host = hostname.replace(/\.$/, "").toLowerCase();
  const domain = registrableDomain(host);
  const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

  const [a, aaaa, mxRaw, ns, txtRaw, cname, caaRaw, soa] = await Promise.all([
    safe(resolver.resolve4(host), [] as string[]),
    safe(resolver.resolve6(host), [] as string[]),
    safe(resolver.resolveMx(domain), [] as { exchange: string; priority: number }[]),
    safe(resolver.resolveNs(domain), [] as string[]),
    safe(resolver.resolveTxt(domain), [] as string[][]),
    safe(resolver.resolveCname(host), [] as string[]),
    safe((resolver as any).resolveCaa(domain) as Promise<any[]>, [] as any[]),
    safe(resolver.resolveSoa(domain), null as dns.SoaRecord | null),
  ]);

  const mx = mxRaw.map((m) => ({ exchange: m.exchange.toLowerCase(), priority: m.priority })).sort((x, y) => x.priority - y.priority);
  const txt = txtRaw.map((parts) => parts.join(""));
  const caa = caaRaw.map((c) => (c.issue ? `issue ${c.issue}` : c.issuewild ? `issuewild ${c.issuewild}` : c.iodef ? `iodef ${c.iodef}` : JSON.stringify(c)));

  return {
    a,
    aaaa,
    mx,
    ns: ns.map((n) => n.toLowerCase()),
    txt,
    cname,
    caa,
    soa: soa ? soa.nsname : null,
    mailProvider: deriveMailProvider(mx),
    dnsHost: deriveDnsHost(ns),
  };
}

export async function lookupGeo(ip: string | undefined): Promise<GeoInfo> {
  if (!ip) return null;
  const data = await fetchJson(
    `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,city,isp,org,as,reverse`,
    "application/json",
  );
  if (!data || data.status !== "success") return null;
  return {
    ip,
    country: data.country ?? null,
    countryCode: data.countryCode ?? null,
    city: data.city ?? null,
    isp: data.isp ?? null,
    org: data.org ?? null,
    asn: data.as ?? null,
    reverse: data.reverse || null,
  };
}

const DKIM_SELECTORS = ["default", "google", "selector1", "selector2", "k1", "dkim", "mail", "s1"];

export async function checkEmailSecurity(hostname: string, txt: string[]): Promise<EmailSecurity> {
  const domain = registrableDomain(hostname);
  const safeTxt = async (name: string): Promise<string[]> =>
    resolver.resolveTxt(name).then((r) => r.map((p) => p.join(""))).catch(() => []);

  // SPF lives in the apex TXT records we already fetched.
  const spfRecord = txt.find((t) => /^v=spf1/i.test(t)) ?? null;
  let spfSeverity: ReconSeverity = "bad";
  let spfNote: string | undefined = "no SPF record — anyone can send mail as this domain";
  if (spfRecord) {
    if (/[~-]all/.test(spfRecord)) {
      spfSeverity = "ok";
      spfNote = undefined;
    } else if (/\?all|\+all/.test(spfRecord) || !/all/.test(spfRecord)) {
      spfSeverity = "warn";
      spfNote = "SPF present but not enforced (no ~all/-all)";
    }
  }
  const spf: EmailFinding = { name: "SPF", present: Boolean(spfRecord), value: spfRecord, note: spfNote, severity: spfSeverity };

  const dmarcRecords = await safeTxt(`_dmarc.${domain}`);
  const dmarcRecord = dmarcRecords.find((t) => /^v=DMARC1/i.test(t)) ?? null;
  let dmarcSeverity: ReconSeverity = "bad";
  let dmarcNote: string | undefined = "no DMARC record — spoofed mail will not be rejected";
  if (dmarcRecord) {
    const policy = /p=(\w+)/i.exec(dmarcRecord)?.[1]?.toLowerCase();
    if (policy === "reject") {
      dmarcSeverity = "ok";
      dmarcNote = undefined;
    } else if (policy === "quarantine") {
      dmarcSeverity = "warn";
      dmarcNote = "DMARC set to quarantine (not reject)";
    } else {
      dmarcSeverity = "warn";
      dmarcNote = "DMARC policy is p=none — monitoring only, no enforcement";
    }
  }
  const dmarc: EmailFinding = { name: "DMARC", present: Boolean(dmarcRecord), value: dmarcRecord, note: dmarcNote, severity: dmarcSeverity };

  // DKIM has no fixed location; probe a handful of common selectors (best-effort).
  let dkimSelector: string | null = null;
  for (const sel of DKIM_SELECTORS) {
    const recs = await safeTxt(`${sel}._domainkey.${domain}`);
    if (recs.some((r) => /v=DKIM1|k=rsa|p=/i.test(r))) {
      dkimSelector = sel;
      break;
    }
  }
  const dkim: EmailFinding = {
    name: "DKIM",
    present: Boolean(dkimSelector),
    value: dkimSelector ? `selector "${dkimSelector}"` : null,
    note: dkimSelector ? undefined : "no DKIM found at common selectors (may use a custom selector)",
    severity: dkimSelector ? "ok" : "warn",
  };

  // Grade: SPF and DMARC carry the spoofing risk; DKIM is a bonus.
  let earned = 0;
  if (spf.severity === "ok") earned += 40;
  else if (spf.severity === "warn") earned += 20;
  if (dmarc.severity === "ok") earned += 40;
  else if (dmarc.severity === "warn") earned += 20;
  if (dkim.severity === "ok") earned += 20;
  const grade: EmailSecurity["grade"] = earned >= 90 ? "A" : earned >= 70 ? "B" : earned >= 50 ? "C" : earned >= 30 ? "D" : "F";
  const spoofable = spf.severity !== "ok" || dmarc.severity !== "ok";

  return { spf, dmarc, dkim, grade, spoofable };
}
