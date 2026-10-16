/** A bounded synthetic workload, local collection and loopback-only uploads. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { Profile } from "pprof-format";
import { readConfig } from "../src/config.ts";
import { Diagnostics } from "../src/service.ts";

const seconds = Number(process.argv[2] || 60);
if (!Number.isFinite(seconds) || seconds < 10 || seconds > 3600) throw new Error("Duration must be 10–3600 seconds");
const dir = await mkdtemp(join(tmpdir(), "pi-perf-soak-"));
const types = new Set<string>();
let uploads = 0;
let bytes = 0;
const backend = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const data = Buffer.concat(chunks);
  bytes += data.length;
  const profile = Profile.decode(gunzipSync(data));
  for (const type of profile.sampleType) types.add(profile.stringTable.strings[Number(type.type)]!);
  uploads++;
  res.writeHead(200).end();
});
await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
const address = backend.address();
assert.ok(address && typeof address !== "string");
const config = readConfig({
  PI_PERF_DIR: dir, PI_PERF_INTERVAL_MS: "1000", PI_PERF_PROFILES: "1",
  PI_PERF_PROFILE_INTERVAL_MS: "10000", PYROSCOPE_SERVER_ADDRESS: "http://127.0.0.1:" + address.port,
});
const d = new Diagnostics(config, { mode: () => "synthetic", sessionFile: () => undefined,
  branchMessages: () => 1000, busy: () => true }, "test");
const retained: Uint8Array[] = [];
try {
  await d.start();
  const cpu = process.cpuUsage();
  const start = performance.now();
  while (performance.now() - start < seconds * 1000) {
    retained.push(new Uint8Array(64 * 1024));
    if (retained.length > 8) retained.shift();
    const until = performance.now() + 5;
    while (performance.now() < until) Math.sqrt(Math.random());
    await sleep(195);
  }
  await d.stop();
  assert.ok(uploads >= 2, "periodic upload must work");
  assert.equal(d.state().failures, 0);
  assert.ok(types.has("cpu") && types.has("wall") && [...types].some((t) => t.includes("space")));
  const usage = process.cpuUsage(cpu);
  console.log(JSON.stringify({
    seconds, uploads, bytes, sampleTypes: [...types], dropped: d.state().dropped,
    cpuSecondsIncludingSyntheticWork: (usage.user + usage.system) / 1e6,
    finalRssMiB: (d.sample?.rss_bytes ?? 0) / 1024 / 1024,
  }, null, 2));
} finally {
  await d.stop();
  await new Promise<void>((resolve) => { backend.close(() => resolve()); backend.closeAllConnections(); });
  await rm(dir, { recursive: true, force: true });
}
