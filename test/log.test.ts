import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RotatingLog } from "../src/log.ts";

test("bounded rotation, private files, append across reload, and backpressure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-perf-log-"));
  try {
    const log = new RotatingLog(dir, "test.jsonl", 128);
    await log.init();
    log.write({ n: 0 }); log.write({ n: 999 });
    assert.equal(log.dropped, 1);
    await log.flush();
    for (let n = 1; n < 20; n++) { log.write({ n, padding: "x".repeat(40) }); await log.flush(); }
    await log.close(); await log.close();
    const files = await readdir(dir);
    assert.equal(files.length, 3);
    for (const f of files) {
      const s = await stat(join(dir, f));
      assert.ok(s.size <= 128);
      assert.equal(s.mode & 0o777, 0o600);
      for (const line of (await readFile(join(dir, f), "utf8")).trim().split("\n")) JSON.parse(line);
    }
    const reopened = new RotatingLog(dir, "test.jsonl", 128);
    await reopened.init();
    reopened.write({ reopened: true }); await reopened.close();
    assert.match(await readFile(join(dir, "test.jsonl"), "utf8"), /reopened/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("refuses a symlink output file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-perf-symlink-"));
  try {
    await symlink(join(dir, "victim"), join(dir, "test.jsonl"));
    const log = new RotatingLog(dir, "test.jsonl", 128);
    await assert.rejects(log.init());
    await log.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
