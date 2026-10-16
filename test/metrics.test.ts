import assert from "node:assert/strict";
import { test } from "node:test";
import { MetricsServer, renderMetrics, type MetricsState } from "../src/metrics.ts";
const state: MetricsState = {
  instance: "test-instance", dropped: 1, logErrors: 0, profilesActive: false,
  uploads: 0, failures: 0, marks: { lag: 2, baseline: 1, recovered: 0 },
};
test("loopback endpoint exposes low-cardinality process metrics and closes", async () => {
  const server = new MetricsServer();
  await server.start(0, () => state);
  const url = "http://127.0.0.1:" + server.port;
  try {
    const r = await fetch(url + "/metrics");
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.match(text, /pi_perf_log_dropped_total\{pi_instance="test-instance",pid="\d+"\} 1/);
    assert.match(text, /kind="lag"\} 2/);
    assert.doesNotMatch(text, /session|prompt|project|secret/);
    assert.equal((await fetch(url + "/other")).status, 404);
  } finally { await server.close(); await server.close(); }
  await assert.rejects(fetch(url + "/metrics"));
});
test("escapes labels", () => {
  assert.ok(renderMetrics({ ...state, instance: 'x"y' }).includes('pi_instance="x\\"y"'));
});
