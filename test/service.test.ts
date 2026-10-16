import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { readConfig } from "../src/config.ts";
import { Diagnostics } from "../src/service.ts";

test("repeated session runtimes append to bounded logs and release the metrics socket", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-perf-service-"));
  let recounts = 0;
  const sessionFile = join(dir, "PRIVATE-PROJECT-session.jsonl");
  await writeFile(sessionFile, "PRIVATE PROMPT AND TOOL PAYLOAD");
  const config = readConfig({ PI_PERF_DIR: dir, PI_PERF_METRICS_PORT: "0", PI_PERF_LOG_MAX_BYTES: "16384" });
  try {
    let previousInstance = "";
    for (let i = 0; i < 8; i++) {
      const d = new Diagnostics(config, {
        mode: () => "regular", sessionFile: () => sessionFile,
        branchMessages: () => { recounts++; return 200; }, busy: () => false,
      }, "test");
      await d.start();
      const current = d.state();
      assert.notEqual(current.instance, previousInstance);
      previousInstance = current.instance;
      for (let j = 0; j < 4; j++) { await d.tick(); await d.log.flush(); }
      d.messageEnded();
      await d.tick();
      assert.equal(d.sample?.branch_messages, 201);
      assert.equal(d.sample?.session_file_bytes, Buffer.byteLength("PRIVATE PROMPT AND TOOL PAYLOAD"));
      await d.mark("lag");
      assert.equal(d.state().marks.lag, 1);
      assert.equal(d.state().profilesActive, false);
      await d.stop(); await d.stop();
      assert.equal(d.active, false);
      await assert.rejects(d.mark("lag"));
    }
    assert.equal(recounts, 8, "no repeated transcript scans during sampling");
    const files = (await readdir(dir)).filter((f) => f.startsWith("pi-"));
    assert.ok(files.length <= 3, "reload must not create a new set of logs");
    for (const f of files) {
      const output = await readFile(join(dir, f), "utf8");
      assert.doesNotMatch(output, /PRIVATE|PROMPT|PAYLOAD|session\.jsonl/);
      assert.doesNotMatch(output, /Authorization|password|basicAuth/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("slow upload failure cannot disable local collection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-perf-failure-"));
  const d = new Diagnostics({
    ...readConfig({ PI_PERF_DIR: dir }), profiles: true,
    serverAddress: "http://127.0.0.1:1", profileIntervalMs: 250,
  }, { mode: () => "regular", sessionFile: () => undefined, branchMessages: () => 0, busy: () => false }, "test");
  try {
    await d.start();
    await sleep(400);
    await d.tick();
    assert.equal(d.active, true);
    assert.ok(d.sample!.heap_used_bytes > 0);
    assert.ok(d.state().failures > 0);
    assert.match(d.status(), /Profiles: running/);
  } finally { await d.stop(); await rm(dir, { recursive: true, force: true }); }
});
