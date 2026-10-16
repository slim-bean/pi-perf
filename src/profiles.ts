import { createRequire } from "node:module";
import type { Config } from "./config.ts";
import { UploadRelay } from "./relay.ts";
import type { UploadResult } from "./upload-diagnostics.ts";

type SDK = typeof import("@pyroscope/nodejs").default;
const ownerKey = Symbol.for("pi-perf.profiler-owner.v1");
const owners = globalThis as typeof globalThis & { [ownerKey]?: symbol };

export class Profiles {
  private sdk?: SDK;
  private relay?: UploadRelay;
  private owner = Symbol("pi-perf");
  private stopPending?: Promise<void>;
  active = false;
  error?: string;

  constructor(private config: Config, private tags: Record<string, string>, private onUpload?: (result: UploadResult) => void) {}

  async start(): Promise<void> {
    if (!this.config.profiles || this.active) return;
    await this.stopPending;
    this.stopPending = undefined;
    if (process.env.PYROSCOPE_ADHOC_SERVER_ADDRESS) { this.error = "unsupported_adhoc_override"; return; }
    if (process.execArgv.some((arg) => arg === "--cpu-prof" || arg.startsWith("--cpu-prof="))) {
      this.error = "competing_cpu_profiler"; return;
    }
    if (owners[ownerKey]) { this.error = "profiler_already_owned"; return; }
    owners[ownerKey] = this.owner;
    try {
      // Use a real Node module root for native dependencies, not jiti's reload cache.
      const sdk = (createRequire(import.meta.url)("@pyroscope/nodejs") as { default: SDK }).default;
      this.sdk = sdk;
      const silent = () => {};
      sdk.setLogger({ error: silent, warn: silent, fatal: silent, info: silent, debug: silent, trace: silent });
      this.relay = new UploadRelay(this.config, 5000, this.onUpload);
      await this.relay.start();
      sdk.init({
        appName: "pi",
        serverAddress: this.relay.address,
        authToken: this.relay.password,
        flushIntervalMs: this.config.profileIntervalMs,
        wall: {
          collectCpuTime: true,
          samplingIntervalMicros: 10_000,
          samplingDurationMs: this.config.profileIntervalMs,
        },
        heap: { samplingIntervalBytes: 512 * 1024, stackDepth: 64 },
        tags: this.tags,
      });
      sdk.start();
      this.active = true;
    } catch {
      // Never emit native/module/network error strings: they may contain secrets/paths.
      this.error = "profiler_start_failed";
      await this.stop();
    }
  }

  get lastUpload() { return this.relay?.lastUpload; }
  get uploads() { return this.relay?.uploaded ?? 0; }
  get failures() { return (this.relay?.failed ?? 0) + (this.relay?.rejected ?? 0); }

  stop(): Promise<void> {
    return this.stopPending ??= this.stopOnce();
  }

  private async stopOnce(): Promise<void> {
    try {
      if (this.sdk && owners[ownerKey] === this.owner) await this.sdk.stop();
    } catch { this.error = "profiler_stop_failed"; }
    finally {
      this.active = false;
      await this.relay?.close();
      this.sdk = undefined;
      if (owners[ownerKey] === this.owner) delete owners[ownerKey];
    }
  }
}
