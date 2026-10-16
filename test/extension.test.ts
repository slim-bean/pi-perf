import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piPerf from "../src/index.ts";

test("factory is inert; disabled startup and serialized commands honor lifecycle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-perf-extension-"));
  const saved = { ...process.env };
  process.env.PI_PERF_ENABLE = "0";
  process.env.PI_PERF_DIR = dir;
  delete process.env.PI_PERF_PROFILES;
  delete process.env.PI_PERF_METRICS_PORT;
  const events = new Map<string, (event: any, ctx: any) => any>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const notices: string[] = [];
  const pi = {
    on: (name: string, handler: any) => { events.set(name, handler); },
    registerCommand: (name: string, options: any) => {
      assert.equal(typeof options.getArgumentCompletions, "function");
      commands.set(name, options.handler);
    },
    getSettings: () => ({ tuiMode: "regular" }),
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui", hasUI: true, isIdle: () => true,
    ui: { notify: (text: string) => notices.push(text) },
    sessionManager: { getSessionFile: () => undefined, getBranch: () => [] },
  } as unknown as ExtensionContext;
  try {
    piPerf(pi);
    assert.deepEqual(await readdir(dir), []);
    await events.get("session_start")!({ reason: "startup" }, ctx);
    assert.deepEqual(await readdir(dir), []);
    await commands.get("perf")!("status", ctx);
    assert.match(notices.at(-1)!, /stopped/);
    await commands.get("perf")!("config", ctx);
    assert.match(notices.at(-1)!, /configuration inherited/);
    await commands.get("perf")!("debug on", ctx);
    assert.match(notices.at(-1)!, /Upload debug logging: on/);
    await Promise.all([commands.get("perf")!("start", ctx), commands.get("perf")!("stop", ctx)]);
    await commands.get("perf")!("status", ctx);
    assert.match(notices.at(-1)!, /pi-perf: stopped/);
    await commands.get("perf")!("mark PRIVATE PROMPT", ctx);
    assert.match(notices.at(-1)!, /Usage:/);
    await commands.get("perf")!("start", ctx);
    await commands.get("perf")!("mark", ctx);
    assert.match(notices.at(-1)!, /lag marker/);
    await commands.get("perf")!("debug off", ctx);
    assert.match(notices.at(-1)!, /Upload debug logging: off/);
    await commands.get("perf")!("debug not-valid", ctx);
    assert.match(notices.at(-1)!, /Usage:/);
    await events.get("session_shutdown")!({ reason: "reload" }, ctx);
    await events.get("session_shutdown")!({ reason: "quit" }, ctx);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(dir, { recursive: true, force: true });
  }
});
