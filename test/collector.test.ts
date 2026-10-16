import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Collector } from "../src/collector.ts";

test("records finite memory/CPU and detects an event-loop stall; resets per window", async () => {
  const c = new Collector();
  try {
    await sleep(60);
    const until = performance.now() + 110;
    while (performance.now() < until) Math.sqrt(Math.random());
    await sleep(50);
    const sample = c.sample({ busy: true, branchMessages: 17, sessionFileBytes: 1234 });
    for (const value of Object.values(sample)) {
      if (typeof value === "number") assert.ok(Number.isFinite(value) && value >= 0);
    }
    assert.ok(sample.event_loop_delay_max_seconds > 0.08);
    assert.ok(sample.cpu_ratio > 0.05);
    assert.ok(sample.heap_used_bytes > 0);
    assert.equal(sample.busy, 1);
    assert.equal(sample.branch_messages, 17);
    assert.equal(sample.session_file_bytes, 1234);
    await sleep(80);
    const next = c.sample({ busy: false, branchMessages: 17, sessionFileBytes: 1234 });
    assert.ok(next.event_loop_delay_max_seconds < sample.event_loop_delay_max_seconds);
  } finally { c.close(); c.close(); }
});
