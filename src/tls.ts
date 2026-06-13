import tls from "tls";
import type { TlsInfo, TlsFinding, ReconSeverity } from "./util";

// Passive: a normal TLS handshake (the same one any browser performs). We read
// the certificate and negotiated parameters the server offers — no probing.

type HandshakeResult = {
  protocol: string | null;
  cipher: string | null;
  cert: tls.PeerCertificate | null;
  authorized: boolean;
};

function handshake(host: string, opts: { maxVersion?: tls.SecureVersion; minVersion?: tls.SecureVersion }, timeoutMs = 8000): Promise<HandshakeResult> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port: 443,
        servername: host,
        rejectUnauthorized: false, // we inspect the cert ourselves rather than failing the run
        ...opts,
      },
      () => {
        const result: HandshakeResult = {
          protocol: socket.getProtocol(),
          cipher: socket.getCipher()?.name ?? null,
          cert: socket.getPeerCertificate(true),
          authorized: socket.authorized,
        };
        socket.end();
        resolve(result);
      },
    );
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error("TLS handshake timed out"));
    });
    socket.on("error", (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

function daysUntil(dateStr: string | undefined): number | null {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return null;
  return Math.round((t - Date.now()) / (24 * 3600 * 1000));
}

export async function inspectTls(hostname: string): Promise<TlsInfo> {
  const host = hostname.replace(/\.$/, "");
  let main: HandshakeResult;
  try {
    main = await handshake(host, {});
  } catch (err) {
    return {
      ok: false,
      protocol: null,
      cipher: null,
      issuer: null,
      subject: null,
      validFrom: null,
      validTo: null,
      daysToExpiry: null,
      san: [],
      selfSigned: false,
      legacyProtocols: [],
      grade: "F",
      findings: [{ name: "Handshake", severity: "bad", detail: (err as Error).message }],
      note: "TLS handshake failed (HTTP-only host or non-standard port?)",
    };
  }

  const cert = main.cert;
  const issuerCN = cert?.issuer?.CN ?? null;
  const issuerO = cert?.issuer?.O ?? null;
  const subjectCN = cert?.subject?.CN ?? null;
  const san = (cert?.subjectaltname ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^DNS:/, ""))
    .filter(Boolean);
  const daysToExpiry = daysUntil(cert?.valid_to);
  const selfSigned = Boolean(cert && issuerCN && subjectCN && issuerCN === subjectCN && !main.authorized);

  // Probe whether the host still accepts legacy TLS — a short pinned handshake each.
  const legacyProtocols: string[] = [];
  for (const v of ["TLSv1.1", "TLSv1"] as tls.SecureVersion[]) {
    try {
      await handshake(host, { minVersion: v, maxVersion: v }, 5000);
      legacyProtocols.push(v);
    } catch {
      // host rejected the legacy protocol — good
    }
  }

  const findings: TlsFinding[] = [];
  const add = (name: string, severity: ReconSeverity, detail: string) => findings.push({ name, severity, detail });

  if (main.protocol === "TLSv1.3") add("Protocol", "ok", "negotiates TLS 1.3");
  else if (main.protocol === "TLSv1.2") add("Protocol", "ok", "negotiates TLS 1.2");
  else add("Protocol", "bad", `negotiates ${main.protocol ?? "unknown"}`);

  if (legacyProtocols.length > 0) add("Legacy protocols", "bad", `still accepts ${legacyProtocols.join(", ")} — deprecated and insecure`);
  else add("Legacy protocols", "ok", "TLS 1.0/1.1 disabled");

  if (selfSigned) add("Certificate", "bad", "self-signed / not trusted");
  else if (!main.authorized) add("Certificate", "warn", "chain did not validate against system roots");
  else add("Certificate", "ok", `issued by ${issuerO || issuerCN || "a trusted CA"}`);

  if (daysToExpiry !== null) {
    if (daysToExpiry < 0) add("Expiry", "bad", `expired ${Math.abs(daysToExpiry)} day(s) ago`);
    else if (daysToExpiry < 14) add("Expiry", "bad", `expires in ${daysToExpiry} day(s)`);
    else if (daysToExpiry < 30) add("Expiry", "warn", `expires in ${daysToExpiry} day(s)`);
    else add("Expiry", "ok", `valid for ${daysToExpiry} more day(s)`);
  }

  // Grade off the worst finding.
  const hasBad = findings.some((f) => f.severity === "bad");
  const hasWarn = findings.some((f) => f.severity === "warn");
  const grade: "A" | "B" | "C" | "D" | "F" = hasBad
    ? (selfSigned || (daysToExpiry !== null && daysToExpiry < 0) ? "F" : "D")
    : hasWarn
      ? "B"
      : "A";

  return {
    ok: true,
    protocol: main.protocol,
    cipher: main.cipher,
    issuer: issuerO ? `${issuerO}${issuerCN && issuerCN !== issuerO ? ` (${issuerCN})` : ""}` : issuerCN,
    subject: subjectCN,
    validFrom: cert?.valid_from ?? null,
    validTo: cert?.valid_to ?? null,
    daysToExpiry,
    san: san.slice(0, 20),
    selfSigned,
    legacyProtocols,
    grade,
    findings,
  };
}
