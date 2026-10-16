import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { readConfig } from "../src/config.ts";
import { Diagnostics } from "../src/service.ts";

test("opt-in upload logging writes safe records and status includes the last HTTP result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-perf-debug-"));
  const backend = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    res.writeHead(401).end("SECRET_RESPONSE");
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const address = backend.address();
  assert.ok(address && typeof address !== "string");
  const config = {
    ...readConfig({ PI_PERF_DIR: dir, PI_PERF_DEBUG: "1", PI_PERF_PROFILES: "1",
      PYROSCOPE_SERVER_ADDRESS: "http://127.0.0.1:" + address.port + "/SECRET_PATH",
      PYROSCOPE_BASIC_AUTH_USER: "SECRET_USER", PYROSCOPE_BASIC_AUTH_PASSWORD: "SECRET_PASSWORD" }),
    profileIntervalMs: 250,
  };
  const d = new Diagnostics(config, { mode: () => "regular", sessionFile: () => undefined,
    branchMessages: () => 0, busy: () => false }, "test");
  try {
    await d.start();
    for (let i = 0; i < 30 && d.state().failures === 0; i++) await sleep(50);
    assert.match(d.status(), /http_error HTTP 401/);
    assert.match(d.status(), /<redacted-path>/);
    assert.match(d.debugStatus(), /logging: on/);
    d.setDebug(false);
    assert.match(d.debugStatus(), /logging: off/);
    await d.stop();
    const content = await readFile(d.log.path, "utf8");
    const records = content.trim().split("\n").map((s) => JSON.parse(s));
    assert.ok(records.some((r) => r.kind === "profile_upload" && r.status === 401));
    assert.doesNotMatch(content, /SECRET_|Authorization|Bearer |Basic /);
  } finally {
    await d.stop();
    await new Promise<void>((resolve) => { backend.close(() => resolve()); backend.closeAllConnections(); });
    await rm(dir, { recursive: true, force: true });
  }
});
