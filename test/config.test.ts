import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../src/config.ts";

test("local-only defaults; standard Pyroscope variables do not opt in", () => {
  const c = readConfig({ PYROSCOPE_SERVER_ADDRESS: "https://example.com", PYROSCOPE_AUTH_TOKEN: "not-read" }, "/tmp/agent");
  assert.equal(c.profiles, false);
  assert.equal(c.enabled, true);
  assert.equal(c.metricsPort, undefined);
  assert.equal(c.logDir, "/tmp/agent/perf");
  assert.equal(c.intervalMs, 10000);
});
test("validates upload opt-in, TLS, credentials, and unsafe SDK override", () => {
  for (const env of [
    { PI_PERF_PROFILES: "1" },
    { PI_PERF_PROFILES: "1", PYROSCOPE_SERVER_ADDRESS: "http://example.com" },
    { PI_PERF_PROFILES: "1", PYROSCOPE_SERVER_ADDRESS: "https://user:secret@example.com" },
    { PI_PERF_PROFILES: "1", PYROSCOPE_SERVER_ADDRESS: "https://example.com/?token=secret" },
    { PI_PERF_PROFILES: "1", PYROSCOPE_SERVER_ADDRESS: "https://example.com", PYROSCOPE_BASIC_AUTH_USER: "only-one" },
    { PI_PERF_PROFILES: "1", PYROSCOPE_SERVER_ADDRESS: "https://example.com", PYROSCOPE_ADHOC_SERVER_ADDRESS: "http://other" },
  ]) {
    assert.throws(() => readConfig(env), (error: unknown) => error instanceof Error && !error.message.includes("secret"));
  }
  const c = readConfig({ PI_PERF_PROFILES: "1", PYROSCOPE_SERVER_ADDRESS: "http://127.0.0.1:4040" });
  assert.equal(c.profiles, true);
});
test("rejects invalid bounds and arbitrary labels; permits disabled and ephemeral metrics", () => {
  for (const env of [
    { PI_PERF_INTERVAL_MS: "0" }, { PI_PERF_INTERVAL_MS: "NaN" }, { PI_PERF_LOG_MAX_BYTES: "1" },
    { PI_PERF_METRICS_PORT: "-1" }, { PI_PERF_CONFIGURATION: "private project name" }, { PI_PERF_DIR: "relative" },
  ]) assert.throws(() => readConfig(env));
  assert.equal(readConfig({ PI_PERF_ENABLE: "0", PI_PERF_METRICS_PORT: "0" }).enabled, false);
  assert.equal(readConfig({ PI_PERF_METRICS_PORT: "0" }).metricsPort, 0);
});
