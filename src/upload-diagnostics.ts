import { createConnection, isIP } from "node:net";
import { connect as connectTls } from "node:tls";

export interface UploadResult {
  timestamp: string;
  target: string;
  result: "ok" | "http_error" | "network_error" | "timeout" | "too_large" | "cancelled" | "busy";
  duration_ms: number;
  bytes: number;
  status?: number;
  code?: string;
}

/** URL origins cannot include userinfo; custom paths/queries may contain secrets. */
export function safeTarget(address?: string): string {
  if (!address) return "(not set)";
  try {
    const url = new URL(address);
    if (!["http:", "https:"].includes(url.protocol)) return "(invalid HTTP URL)";
    const path = url.pathname.replace(/\/$/, "");
    return url.origin + (path ? "/<redacted-path>" : "") + "/ingest";
  } catch { return "(invalid HTTP URL)"; }
}

const networkCodes = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID", "UND_ERR_CONNECT_TIMEOUT", "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
]);
export function networkCode(error: unknown): string {
  if (!error || typeof error !== "object") return "network_error";
  const e = error as { code?: unknown; cause?: { code?: unknown } };
  for (const code of [e.code, e.cause?.code]) {
    if (typeof code === "string" && networkCodes.has(code)) return code;
  }
  return "network_error";
}

export function formatUpload(result?: UploadResult): string {
  if (!result) return "No upload attempted yet.";
  return `${result.timestamp} · ${result.result}${result.status ? " HTTP " + result.status : ""}${result.code ? " " + result.code : ""} · ${result.duration_ms}ms · ${result.bytes} bytes`;
}

/** Connectivity only: sends no HTTP request, credentials, or profiles. */
export async function checkEndpoint(address: string, timeoutMs = 3000): Promise<string> {
  let url: URL;
  try { url = new URL(address); } catch { return "Invalid endpoint URL; no connection attempted."; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    return "Endpoint must be HTTP(S), without URL credentials, query, or fragment; no connection attempted.";
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const tls = url.protocol === "https:";
  if (!tls && !["127.0.0.1", "::1", "localhost"].includes(host)) {
    return "Use HTTPS for a non-loopback endpoint; no connection attempted.";
  }
  const port = Number(url.port || (tls ? 443 : 80));
  const result = await new Promise<string>((resolve) => {
    const socket = tls
      ? connectTls({ host, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: true })
      : createConnection({ host, port });
    let done = false;
    const finish = (text: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(text);
    };
    const timer = setTimeout(() => finish("Connection timed out."), timeoutMs);
    socket.once(tls ? "secureConnect" : "connect", () => finish(tls ? "TCP/TLS connection succeeded." : "TCP connection succeeded."));
    socket.once("error", (error) => finish("Connection failed: " + networkCode(error)));
  });
  return `Target: ${safeTarget(address)}\n${result}\nConnectivity only: this does not verify the /ingest route or delivery beyond Alloy. Check upload results and Alloy's pyroscope.write metrics next.`;
}
