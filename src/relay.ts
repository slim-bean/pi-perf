import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Config } from "./config.ts";
import { networkCode, safeTarget, type UploadResult } from "./upload-diagnostics.ts";

/**
 * SDK 0.6.5 has no upload timeout/transport hook. A private loopback relay bounds
 * network waits without replacing global fetch or reaching into SDK internals.
 * Request bodies stream to the upstream; no retry or unbounded profile queue.
 */
export class UploadRelay {
  private server?: Server;
  private active = new Set<AbortController>();
  readonly password = randomBytes(24).toString("hex");
  address = "";
  uploaded = 0;
  failed = 0;
  rejected = 0;
  lastUpload?: UploadResult;
  private closing = false;

  constructor(private config: Config, private timeoutMs = 5000, private onUpload?: (result: UploadResult) => void) {}

  private report(result: Omit<UploadResult, "timestamp" | "target">): void {
    this.lastUpload = {
      timestamp: new Date().toISOString(), target: safeTarget(this.config.serverAddress), ...result,
    };
    try { this.onUpload?.(this.lastUpload); } catch { /* Diagnostics must never break upload. */ }
  }

  async start(): Promise<void> {
    const expectedAuth = "Bearer " + this.password;
    this.server = createServer(async (req, res) => {
      let input: URL;
      try { input = new URL(req.url || "/", "http://localhost"); }
      catch { res.writeHead(400).end(); req.resume(); return; }
      if (this.closing || req.method !== "POST" || input.pathname !== "/ingest" ||
          req.headers.authorization !== expectedAuth) {
        res.writeHead(403).end(); req.resume(); return;
      }
      if (this.active.size >= 2) {
        this.rejected++;
        this.report({ result: "busy", duration_ms: 0, bytes: 0 });
        res.writeHead(429).end(); req.resume(); return;
      }
      const controller = new AbortController();
      this.active.add(controller);
      const started = performance.now();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      timer.unref();
      let bytes = 0;
      let tooLarge = false;
      async function* boundedBody() {
        for await (const chunk of req) {
          bytes += (chunk as Buffer).length;
          if (bytes > 32 * 1024 * 1024) {
            tooLarge = true; controller.abort(); throw new Error("profile_too_large");
          }
          yield chunk;
        }
      }
      req.once("aborted", () => controller.abort());
      try {
        const url = new URL(this.config.serverAddress!.replace(/\/$/, "") + "/ingest");
        url.search = input.search;
        const headers = new Headers({ "content-type": "application/octet-stream" });
        if (this.config.basicAuthUser && this.config.basicAuthPassword) {
          headers.set("authorization", "Basic " + Buffer.from(
            this.config.basicAuthUser + ":" + this.config.basicAuthPassword).toString("base64"));
        }
        if (this.config.tenantID) headers.set("X-Scope-OrgID", this.config.tenantID);
        const response = await fetch(url, {
          method: "POST", headers, body: boundedBody() as unknown as BodyInit,
          duplex: "half", signal: controller.signal, redirect: "manual",
        } as RequestInit);
        await response.body?.cancel();
        if (response.ok) this.uploaded++;
        else this.failed++;
        this.report({ result: response.ok ? "ok" : "http_error", status: response.status,
          duration_ms: Math.round(performance.now() - started), bytes });
        res.writeHead(response.ok ? 200 : 502).end();
      } catch (error) {
        this.failed++;
        this.report({
          result: tooLarge ? "too_large" : this.closing ? "cancelled" : controller.signal.aborted ? "timeout" : "network_error",
          code: controller.signal.aborted ? undefined : networkCode(error),
          duration_ms: Math.round(performance.now() - started), bytes,
        });
        if (!res.destroyed) res.writeHead(502).end();
      } finally {
        clearTimeout(timer);
        this.active.delete(controller);
      }
    });
    this.server.requestTimeout = this.timeoutMs + 1000;
    this.server.headersTimeout = this.timeoutMs + 1000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    this.server.on("error", () => { this.failed++; });
    this.server.unref();
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Profile relay could not bind");
    this.address = "http://127.0.0.1:" + address.port;
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.active) controller.abort();
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}
