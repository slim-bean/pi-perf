/**
 * Auth-free integration test. A fresh HOME and PI_CODING_AGENT_DIR, empty auth
 * store, explicit extensions only, offline, no provider prompt, no inherited
 * credentials. Never launch against the user's normal agent directory.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { Profile } from "pprof-format";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agent = await mkdtemp(join(tmpdir(), "pi-perf-smoke-"));
const profileMode = process.argv.includes("--profiles");
const profileTypes = new Set<string>();
let uploads = 0;
const backend = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const profile = Profile.decode(gunzipSync(Buffer.concat(chunks)));
  for (const type of profile.sampleType) profileTypes.add(profile.stringTable.strings[Number(type.type)]!);
  uploads++;
  res.writeHead(200).end();
});
let profileAddress = "";
if (profileMode) {
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const address = backend.address();
  assert.ok(address && typeof address !== "string");
  profileAddress = "http://127.0.0.1:" + address.port;
}
const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle", "cli.js");
const helper = join(agent, "smoke.ts");
await writeFile(join(agent, "auth.json"), "{}\n", { mode: 0o600 });
await writeFile(join(agent, "settings.json"), "{}\n");
await writeFile(helper, `
export default function(pi) {
  pi.registerCommand("perf-smoke-reload", {
    handler: async (_args, ctx) => { await ctx.reload(); }
  });
  pi.registerCommand("perf-smoke-stall", {
    handler: async () => {
      const until = performance.now() + 140;
      while (performance.now() < until) Math.sqrt(Math.random());
    }
  });
}
`);
const child = spawn(process.execPath, [
  cli, "--offline", "--mode", "rpc", "--no-session", "--no-extensions",
  "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes",
  "-e", join(root, "src/index.ts"), "-e", helper,
], {
  cwd: agent,
  env: {
    PATH: process.env.PATH, HOME: agent, TMPDIR: tmpdir(),
    PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
    PI_PERF_DIR: join(agent, "perf"), PI_PERF_INTERVAL_MS: "250", PI_PERF_METRICS_PORT: "0",
    ...(profileMode ? { PI_PERF_PROFILES: "1", PYROSCOPE_SERVER_ADDRESS: profileAddress,
      PI_PERF_PROFILE_INTERVAL_MS: "10000" } : {}),
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-8000); });
let buffer = "";
let id = 0;
type Record = { type: string; id?: string; success?: boolean; data?: any; message?: string; method?: string };
const notifications: Record[] = [];
const pending = new Map<string, { resolve: (r: Record) => void; reject: (e: Error) => void }>();
child.stdout.on("data", (data) => {
  buffer += data.toString();
  let index: number;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let record: Record;
    try { record = JSON.parse(line); } catch { throw new Error("Non-JSON output from Pi: " + line); }
    if (record.type === "response" && record.id && pending.has(record.id)) {
      const p = pending.get(record.id)!; pending.delete(record.id);
      if (record.success) p.resolve(record); else p.reject(new Error(JSON.stringify(record)));
    } else {
      notifications.push(record);
      if (notifications.length > 100) notifications.shift();
    }
  }
});
const exit = once(child, "exit");
async function rpc(type: string, fields: object = {}): Promise<Record> {
  const requestId = String(++id);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`RPC timeout: ${type} ${JSON.stringify(fields)}; stderr: ${stderr}`));
    }, 15000);
    pending.set(requestId, {
      resolve: (r) => { clearTimeout(timer); resolve(r); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    child.stdin.write(JSON.stringify({ id: requestId, type, ...fields }) + "\n");
  });
}
async function prompt(message: string) {
  const r = await rpc("prompt", { message });
  assert.equal(r.data?.disposition, "handled", "must never start a provider call");
}
async function records(): Promise<any[]> {
  const filenames = (await readdir(join(agent, "perf"))).filter((f) => f.endsWith(".jsonl"));
  assert.equal(filenames.length, 1);
  return (await readFile(join(agent, "perf", filenames[0]!), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
}

try {
  const commands = await rpc("get_commands");
  assert.ok(commands.data.commands.some((c: any) => c.name === "perf"));
  await prompt("/perf config");
  assert.ok(notifications.some((r) => r.message?.includes("configuration inherited")));
  await prompt("/perf check");
  assert.ok(notifications.some((r) => r.message?.includes(profileMode ? "TCP connection succeeded" : "No endpoint inherited")));
  await prompt("/perf debug on");
  assert.ok(notifications.some((r) => r.message?.includes("Upload debug logging: on")));
  await prompt("/perf status");
  if (profileMode) {
    assert.ok(notifications.some((r) => r.message?.includes("Profiles: running")), "native SDK must load inside Pi/jiti");
    await sleep(11000); // exercise a real periodic heap + wall/CPU upload
  }
  await prompt("/perf mark baseline");
  await sleep(80);
  await prompt("/perf-smoke-stall");
  await sleep(300);
  await prompt("/perf mark lag");
  let lines = await records();
  assert.ok(lines.some((r) => r.kind === "sample" && r.event_loop_delay_max_seconds > 0.10));
  assert.ok(lines.some((r) => r.kind === "mark" && r.marker === "lag"));
  const first = lines.find((r) => r.kind === "start");
  const metrics = await fetch(`http://127.0.0.1:${first.metrics_port}/metrics`).then((r) => r.text());
  assert.match(metrics, /pi_perf_event_loop_delay_p99_seconds/);
  assert.match(metrics, /pi_perf_marks_total.*kind="lag".* 1/);
  await prompt("/perf-smoke-reload");
  lines = await records();
  assert.equal(lines.filter((r) => r.kind === "start").length, 2);
  assert.equal(lines.filter((r) => r.kind === "stop").length, 1);
  await assert.rejects(fetch(`http://127.0.0.1:${first.metrics_port}/metrics`));
  await rpc("new_session");
  lines = await records();
  assert.ok(lines.filter((r) => r.kind === "start").length >= 3);
  assert.equal(lines.filter((r) => r.kind === "start").length, lines.filter((r) => r.kind === "stop").length + 1,
    "session replacement must leave exactly one live diagnostics runtime");
  await prompt("/perf stop");
  await prompt("/perf start");
  await prompt("/perf mark recovered");
  await prompt("/perf status");
  assert.ok(notifications.some((r) => r.type === "extension_ui_request" && r.message?.includes("pi-perf: running")));
  assert.ok(!notifications.some((r) => r.type === "extension_error"), JSON.stringify(notifications));
  child.stdin.end();
  const [code] = await exit;
  assert.equal(code, 0, stderr);
  lines = await records();
  assert.ok(lines.filter((r) => r.kind === "start").length >= 4);
  assert.equal(lines.filter((r) => r.kind === "start").length, lines.filter((r) => r.kind === "stop").length);
  assert.equal(await readFile(join(agent, "auth.json"), "utf8"), "{}\n");
  if (profileMode) {
    assert.ok(lines.some((r) => r.kind === "profile_upload" && r.result === "ok"));
    assert.ok(uploads >= 3);
    assert.ok(profileTypes.has("cpu") && profileTypes.has("wall") && [...profileTypes].some((t) => t.includes("space")));
  }
  console.log(`Pi smoke passed (${profileMode ? "native profiles" : "local only"}): commands, metrics, lag detection, markers, reload, new-session, stop/start, shutdown. No auth/provider calls.`);
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([exit, sleep(2000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  if (profileMode) await new Promise<void>((resolve) => { backend.close(() => resolve()); backend.closeAllConnections(); });
  await rm(agent, { recursive: true, force: true });
}
