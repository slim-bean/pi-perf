import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { Config } from "./config.ts";
import { Collector, type Sample } from "./collector.ts";
import { RotatingLog } from "./log.ts";
import { MetricsServer, type MetricsState } from "./metrics.ts";
import { Profiles } from "./profiles.ts";
import { formatUpload, safeTarget } from "./upload-diagnostics.ts";

export type Marker = "lag" | "baseline" | "recovered";
export interface ContextSource {
  mode(): string;
  sessionFile(): string | undefined;
  branchMessages(): number;
  busy(): boolean;
}

/** One session runtime. No transcript content is retained or serialized. */
export class Diagnostics {
  readonly instance = randomUUID();
  readonly log: RotatingLog;
  readonly marks = { lag: 0, baseline: 0, recovered: 0 };
  private collector?: Collector;
  private metrics = new MetricsServer();
  private profiles?: Profiles;
  private timer?: NodeJS.Timeout;
  private tickPending?: Promise<void>;
  private stopped = false;
  private stopPending?: Promise<void>;
  private sessionFileBytes = 0;
  private branchMessages = 0;
  private errors: string[] = [];
  private debug: boolean;
  sample?: Sample;
  active = false;
  readonly mode: string;

  constructor(readonly config: Config, private source: ContextSource, readonly piVersion: string) {
    this.mode = source.mode();
    this.debug = config.debug;
    // Reuse the same per-process log across reload/new/resume, but use a fresh
    // instance label so counter resets cannot collide in Prometheus.
    this.log = new RotatingLog(config.logDir,
      `pi-${process.pid}-${Math.floor(performance.timeOrigin / 1000)}.jsonl`, config.logMaxBytes);
  }

  async start(): Promise<void> {
    if (this.active || this.stopped) return;
    try { await this.log.init(); } catch { this.log.failed = true; }
    this.collector = new Collector();
    this.recount();
    if (this.config.metricsPort !== undefined) {
      try { await this.metrics.start(this.config.metricsPort, () => this.state()); }
      catch { this.errors.push("metrics_bind_failed"); await this.metrics.close(); }
    }
    this.profiles = new Profiles(this.config, {
      pi_version: this.piVersion,
      tui_mode: this.mode,
      configuration: this.config.configuration,
      pi_instance: this.instance,
    }, (result) => {
      if (this.debug) this.record("profile_upload", { ...result });
    });
    await this.profiles.start();
    this.active = true;
    this.record("start", {
      pi_version: this.piVersion,
      node_version: process.versions.node,
      tui_mode: this.mode,
      configuration: this.config.configuration,
      metrics_port: this.metrics.port,
      profiles_requested: this.config.profiles,
      profiles_active: this.profiles.active,
      profile_error: this.profiles.error,
      profile_target: safeTarget(this.config.serverAddress),
      profile_debug: this.debug,
    });
    await this.log.flush();
    await this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.config.intervalMs);
    this.timer.unref();
  }

  recount(): void { this.branchMessages = this.source.branchMessages(); }
  messageEnded(): void { this.branchMessages++; }

  private record(kind: string, data: object): void {
    this.log.write({
      schema: 1, kind, timestamp: new Date().toISOString(),
      pid: process.pid, instance: this.instance, ...data,
    });
  }

  tick(): Promise<void> {
    if (this.stopped || !this.collector) return Promise.resolve();
    if (this.tickPending) return this.tickPending;
    this.tickPending = this.collect().catch(() => {
      if (!this.errors.includes("sample_failed")) this.errors.push("sample_failed");
    }).finally(() => { this.tickPending = undefined; });
    return this.tickPending;
  }

  private async collect(): Promise<void> {
    const file = this.source.sessionFile();
    this.sessionFileBytes = file ? await stat(file).then((s) => s.size, () => 0) : 0;
    if (this.stopped) return;
    this.sample = this.collector!.sample({
      busy: this.source.busy(),
      branchMessages: this.branchMessages,
      sessionFileBytes: this.sessionFileBytes,
    });
    this.record("sample", {
      ...this.sample,
      log_dropped_total: this.log.dropped,
      profiles_active: this.profiles?.active ?? false,
      profile_error: this.profiles?.error,
      profile_uploads_total: this.profiles?.uploads ?? 0,
      profile_upload_failures_total: this.profiles?.failures ?? 0,
    });
  }

  async mark(kind: Marker): Promise<void> {
    if (!this.active) throw new Error("Diagnostics are stopped; use /perf start");
    this.marks[kind]++;
    // Markers are explicit user operations; wait for at most the one disk write.
    await this.log.flush();
    this.record("mark", { marker: kind, sample: this.sample });
    await this.log.flush();
  }

  setDebug(enabled: boolean): void {
    this.debug = enabled;
    if (this.active) this.record("debug", { enabled });
  }

  debugStatus(): string {
    return `Upload debug logging: ${this.debug ? "on" : "off"}\nLocal log: ${this.log.path}\nLogs contain only safe target, HTTP status, allowlisted error code, bytes, duration, and timestamp—not credentials, response bodies, or payloads.`;
  }

  state(): MetricsState {
    return {
      instance: this.instance, sample: this.sample,
      dropped: this.log.dropped, logErrors: this.log.failed ? 1 : 0,
      profilesActive: this.profiles?.active ?? false,
      uploads: this.profiles?.uploads ?? 0, failures: this.profiles?.failures ?? 0,
      marks: this.marks,
    };
  }

  status(): string {
    const s = this.sample;
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1) + " MiB";
    const errors = [...this.errors, ...(this.profiles?.error ? [this.profiles.error] : []),
      ...(this.log.failed ? ["local_log_failed"] : [])];
    return [
      `pi-perf: ${this.active ? "running" : "stopped"} · PID ${process.pid} · ${this.mode}`,
      `Instance: ${this.instance}`,
      `Local log: ${this.log.path}`,
      `Dropped log records: ${this.log.dropped}`,
      `Profiles: ${this.profiles?.active ? "running" : this.config.profiles ? "not running" : "disabled (PI_PERF_PROFILES is not 1)"} · uploads ${this.profiles?.uploads ?? 0} · failures ${this.profiles?.failures ?? 0}`,
      `Upload target: ${safeTarget(this.config.serverAddress)}`,
      `Profile interval: ${this.config.profileIntervalMs / 1000}s · debug logging ${this.debug ? "on" : "off"}`,
      `Last upload: ${formatUpload(this.profiles?.lastUpload)}`,
      "Upload success means this endpoint accepted the profile, not proof of delivery beyond Alloy.",
      `Prometheus: ${this.metrics.port !== undefined ? "http://127.0.0.1:" + this.metrics.port + "/metrics" : "disabled/unavailable"}`,
      ...(s ? [
        `Sample: ${s.timestamp} · uptime ${Math.round(s.uptime_seconds)}s · window ${s.window_seconds.toFixed(1)}s`,
        `CPU ${(s.cpu_ratio * 100).toFixed(1)}% of one core · ELU ${(s.event_loop_utilization * 100).toFixed(1)}%`,
        `Loop delay p99 ${(s.event_loop_delay_p99_seconds * 1000).toFixed(1)}ms · max ${(s.event_loop_delay_max_seconds * 1000).toFixed(1)}ms (20ms sampling resolution)`,
        `RSS ${mb(s.rss_bytes)} · heap ${mb(s.heap_used_bytes)} / ${mb(s.heap_total_bytes)}`,
        `GC ${s.gc_count_total} events / ${(s.gc_duration_seconds_total * 1000).toFixed(1)}ms · branch messages ${s.branch_messages} · busy ${s.busy}`,
      ] : []),
      `Marks: baseline ${this.marks.baseline} · lag ${this.marks.lag} · recovered ${this.marks.recovered}`,
      ...(errors.length ? ["Errors: " + errors.join(", ")] : []),
    ].join("\n");
  }

  stop(): Promise<void> {
    return this.stopPending ??= this.stopOnce();
  }

  private async stopOnce(): Promise<void> {
    this.stopped = true;
    this.active = false;
    clearInterval(this.timer);
    this.collector?.close();
    await this.tickPending;
    try { await this.profiles?.stop(); }
    finally {
      await this.metrics.close();
      await this.log.flush();
      this.record("stop", { uploads: this.profiles?.uploads ?? 0, failures: this.profiles?.failures ?? 0 });
      await this.log.close();
    }
  }
}
