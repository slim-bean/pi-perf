import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { safeTarget } from "./upload-diagnostics.ts";

export class ConfigError extends Error {}
export const safeConfigError = (error: unknown) => error instanceof ConfigError ? error.message : "Diagnostics operation failed (details redacted).";

export interface Config {
  enabled: boolean;
  intervalMs: number;
  logDir: string;
  logMaxBytes: number;
  profiles: boolean;
  debug: boolean;
  profileIntervalMs: number;
  serverAddress?: string;
  basicAuthUser?: string;
  basicAuthPassword?: string;
  tenantID?: string;
  metricsPort?: number;
  configuration: string;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer from ${min} to ${max}`);
  }
  return n;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env, agentDir = join(homedir(), ".pi", "agent")): Config {
  const logDir = env.PI_PERF_DIR || join(agentDir, "perf");
  if (!isAbsolute(logDir)) throw new ConfigError("PI_PERF_DIR must be an absolute path");
  const serverAddress = env.PYROSCOPE_SERVER_ADDRESS || undefined;
  const profiles = env.PI_PERF_PROFILES === "1";
  if (profiles) {
    if (env.PYROSCOPE_ADHOC_SERVER_ADDRESS) throw new ConfigError("Unset PYROSCOPE_ADHOC_SERVER_ADDRESS; it bypasses the bounded upload relay");
    if (!serverAddress) throw new ConfigError("PI_PERF_PROFILES=1 requires PYROSCOPE_SERVER_ADDRESS");
    let url: URL;
    try { url = new URL(serverAddress); } catch { throw new ConfigError("Invalid PYROSCOPE_SERVER_ADDRESS"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new ConfigError("Pyroscope requires HTTP(S), without URL credentials, query, or fragment");
    }
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new ConfigError("Use HTTPS for non-loopback Pyroscope servers");
    }
  }
  const user = env.PYROSCOPE_BASIC_AUTH_USER || undefined;
  const password = env.PYROSCOPE_BASIC_AUTH_PASSWORD || undefined;
  if (profiles && Boolean(user) !== Boolean(password)) throw new ConfigError("Set both Pyroscope basic auth variables");
  const configuration = env.PI_PERF_CONFIGURATION || "normal";
  if (!/^[a-zA-Z0-9_.-]{1,40}$/.test(configuration)) {
    throw new ConfigError("PI_PERF_CONFIGURATION must be 1–40 letters, digits, dots, underscores, or hyphens");
  }
  return {
    enabled: env.PI_PERF_ENABLE !== "0",
    intervalMs: integer(env, "PI_PERF_INTERVAL_MS", 10_000, 250, 3_600_000),
    logDir,
    logMaxBytes: integer(env, "PI_PERF_LOG_MAX_BYTES", 10 * 1024 * 1024, 1024, 100 * 1024 * 1024),
    profiles,
    debug: env.PI_PERF_DEBUG === "1",
    profileIntervalMs: integer(env, "PI_PERF_PROFILE_INTERVAL_MS", 60_000, 10_000, 300_000),
    serverAddress,
    basicAuthUser: user,
    basicAuthPassword: password,
    tenantID: env.PYROSCOPE_TENANT_ID || undefined,
    metricsPort: env.PI_PERF_METRICS_PORT === undefined || env.PI_PERF_METRICS_PORT === ""
      ? undefined : integer(env, "PI_PERF_METRICS_PORT", 0, 0, 65535),
    configuration,
  };
}

export function describeConfig(env: NodeJS.ProcessEnv = process.env): string {
  const lines = [
    "pi-perf configuration inherited by this Pi process:",
    `PI_PERF_PROFILES: ${env.PI_PERF_PROFILES === undefined ? "unset (profiles disabled)" : env.PI_PERF_PROFILES === "1" ? "1 (enabled)" : "not 1 (profiles disabled)"}`,
    `Upload target: ${safeTarget(env.PYROSCOPE_SERVER_ADDRESS)}`,
    `Basic auth: username ${env.PYROSCOPE_BASIC_AUTH_USER ? "set" : "unset"}; password ${env.PYROSCOPE_BASIC_AUTH_PASSWORD ? "set" : "unset"} (values hidden)`,
  ];
  try {
    const c = readConfig(env);
    lines.push(`Auto-start: ${c.enabled ? "on" : "off"}; upload debug logging: ${c.debug ? "on" : "off"}`,
      `Profile interval: ${c.profileIntervalMs / 1000}s; the first periodic upload waits one interval.`,
      "Configuration validation: OK.");
  } catch (error) { lines.push("Configuration error: " + safeConfigError(error)); }
  lines.push("Use export in ~/.zshrc, then launch a new Pi process. Sourcing a shell file or /reload cannot change this process's inherited environment.");
  return lines.join("\n");
}
