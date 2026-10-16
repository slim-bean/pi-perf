import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { Profile } from "pprof-format";
import { readConfig } from "../src/config.ts";
import { UploadRelay } from "../src/relay.ts";
import { Profiles } from "../src/profiles.ts";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return "http://127.0.0.1:" + address.port;
}
async function close(server: Server) {
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
}

test("native SDK emits gzipped pprof, forwards auth, guards ownership, and restarts", { timeout: 20000 }, async () => {
  const received: Array<{ url: string; auth?: string; tenant?: string; bytes: Buffer }> = [];
  const backend = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url!, auth: req.headers.authorization,
      tenant: req.headers["x-scope-orgid"] as string, bytes: Buffer.concat(chunks) });
    res.writeHead(200).end();
  });
  const address = await listen(backend);
  const config = { ...readConfig({ PI_PERF_PROFILES: "1", PYROSCOPE_SERVER_ADDRESS: address,
    PYROSCOPE_BASIC_AUTH_USER: "stack", PYROSCOPE_BASIC_AUTH_PASSWORD: "test-token", PYROSCOPE_TENANT_ID: "test-tenant" }),
    profileIntervalMs: 250 };
  const p = new Profiles(config, { instance: "native-test", pi_version: "test", tui_mode: "regular" });
  try {
    await p.start();
    assert.equal(p.error, undefined);
    assert.equal(p.active, true);
    const competitor = new Profiles(config, {});
    await competitor.start();
    assert.equal(competitor.error, "profiler_already_owned");
    await competitor.stop();
    for (let i = 0; i < 20 && received.length < 2; i++) {
      const until = performance.now() + 20;
      while (performance.now() < until) Math.sqrt(Math.random());
      await sleep(50);
    }
    await p.stop();
    assert.ok(received.length >= 2, "expected wall/CPU and heap profiles");
    const sampleTypes = new Set<string>();
    for (const r of received) {
      assert.equal(r.auth, "Basic " + Buffer.from("stack:test-token").toString("base64"));
      assert.equal(r.tenant, "test-tenant");
      const url = new URL(r.url, address);
      assert.equal(url.pathname, "/ingest");
      assert.equal(url.searchParams.get("format"), "pprof");
      assert.match(url.searchParams.get("name")!, /instance=native-test/);
      const decoded = Profile.decode(gunzipSync(r.bytes));
      for (const type of decoded.sampleType) sampleTypes.add(decoded.stringTable.strings[Number(type.type)]!);
    }
    assert.ok(sampleTypes.has("cpu"), "must include CPU-time samples");
    assert.ok(sampleTypes.has("wall"), "must include wall-time samples");
    assert.ok([...sampleTypes].some((type) => type.includes("space")), "must include sampled heap bytes: " + [...sampleTypes].join(","));
    assert.ok(p.uploads >= 2);
    assert.equal(p.lastUpload?.status, 200);
    assert.equal(p.lastUpload?.result, "ok");
    await p.stop();
    const restarted = new Profiles(config, { instance: "restart" });
    await restarted.start();
    assert.equal(restarted.active, true);
    await restarted.stop();
  } finally { await p.stop(); await close(backend); }
});

test("relay reports HTTP failures without leaking headers, response bodies, payload, or URL paths", async () => {
  const backend = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume */ }
    res.writeHead(401, { "x-private": "SECRET_HEADER" }).end("SECRET_RESPONSE");
  });
  const address = await listen(backend);
  const config = readConfig({ PI_PERF_PROFILES: "1", PYROSCOPE_SERVER_ADDRESS: address + "/SECRET_PATH",
    PYROSCOPE_BASIC_AUTH_USER: "SECRET_USER", PYROSCOPE_BASIC_AUTH_PASSWORD: "SECRET_TOKEN" });
  const events: unknown[] = [];
  const relay = new UploadRelay(config, 1000, (result) => events.push(result));
  try {
    await relay.start();
    const response = await fetch(relay.address + "/ingest?name=SECRET_LABEL", {
      method: "POST", body: "SECRET_PROFILE_DATA", headers: { authorization: "Bearer " + relay.password },
    });
    assert.equal(response.status, 502);
    assert.equal(relay.lastUpload?.status, 401);
    assert.equal(relay.lastUpload?.result, "http_error");
    assert.equal(relay.lastUpload?.bytes, Buffer.byteLength("SECRET_PROFILE_DATA"));
    assert.match(relay.lastUpload!.target, /<redacted-path>/);
    assert.doesNotMatch(JSON.stringify(events), /SECRET_|authorization|Basic |Bearer /);
    assert.doesNotMatch(JSON.stringify(events), new RegExp(relay.password));
  } finally { await relay.close(); await close(backend); }
});

test("relay bounds network wait, rejects unauthenticated requests, and closes", async () => {
  const backend = createServer(() => { /* deliberately never responds */ });
  const address = await listen(backend);
  const config = readConfig({ PI_PERF_PROFILES: "1", PYROSCOPE_SERVER_ADDRESS: address });
  const relay = new UploadRelay(config, 100);
  try {
    await relay.start();
    assert.equal((await fetch(relay.address + "/ingest", { method: "POST", body: "x" })).status, 403);
    const before = performance.now();
    const r = await fetch(relay.address + "/ingest?format=pprof", {
      method: "POST", body: "x", headers: { authorization: "Bearer " + relay.password },
    });
    assert.equal(r.status, 502);
    assert.ok(performance.now() - before < 2000);
    assert.equal(relay.failed, 1);
    assert.equal(relay.lastUpload?.result, "timeout");
    assert.ok(relay.lastUpload!.duration_ms >= 90);
  } finally { await relay.close(); await close(backend); }
});
