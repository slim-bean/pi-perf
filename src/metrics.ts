import { createServer, type Server } from "node:http";
import type { Sample } from "./collector.ts";

export interface MetricsState {
  instance: string;
  sample?: Sample;
  dropped: number;
  logErrors: number;
  profilesActive: boolean;
  uploads: number;
  failures: number;
  marks: Record<"lag" | "baseline" | "recovered", number>;
}
const escapeLabel = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

export function renderMetrics(state: MetricsState): string {
  const labels = `pi_instance="${escapeLabel(state.instance)}",pid="${process.pid}"`;
  const lines: string[] = [];
  const add = (name: string, type: "gauge" | "counter", value: number, extra = "") => {
    if (!Number.isFinite(value)) return;
    lines.push(`# TYPE ${name} ${type}`, `${name}{${labels}${extra}} ${value}`);
  };
  if (state.sample) {
    for (const [key, value] of Object.entries(state.sample)) {
      if (typeof value === "number") {
        add("pi_perf_" + key, key.endsWith("_total") ? "counter" : "gauge", value);
      }
    }
  }
  add("pi_perf_log_dropped_total", "counter", state.dropped);
  add("pi_perf_log_errors", "gauge", state.logErrors);
  add("pi_perf_profiles_active", "gauge", state.profilesActive ? 1 : 0);
  add("pi_perf_profile_uploads_total", "counter", state.uploads);
  add("pi_perf_profile_upload_failures_total", "counter", state.failures);
  lines.push("# TYPE pi_perf_marks_total counter");
  for (const [kind, n] of Object.entries(state.marks)) {
    lines.push(`pi_perf_marks_total{${labels},kind="${kind}"} ${n}`);
  }
  return lines.join("\n") + "\n";
}

export class MetricsServer {
  private server?: Server;
  port?: number;

  async start(port: number, getState: () => MetricsState): Promise<void> {
    this.server = createServer((req, res) => {
      if (req.method !== "GET" || req.url !== "/metrics") { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(renderMetrics(getState()));
    });
    this.server.requestTimeout = 5000;
    this.server.headersTimeout = 5000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => {
        this.server!.off("error", reject); resolve();
      });
    });
    this.server.on("error", () => {});
    this.server.unref();
    const address = this.server.address();
    if (address && typeof address !== "string") this.port = address.port;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    this.port = undefined;
  }
}
