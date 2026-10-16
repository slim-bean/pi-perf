import assert from "node:assert/strict";
import { test } from "node:test";
import { completeArguments } from "../src/commands.ts";

test("completes subcommands and nested options with full replacement values", async () => {
  assert.deepEqual((await completeArguments(""))!.map((i) => i.value),
    ["status", "config", "check", "debug", "start", "stop", "mark"]);
  assert.deepEqual((await completeArguments("st"))!.map((i) => i.value), ["status", "start", "stop"]);
  assert.deepEqual((await completeArguments("mark "))!.map((i) => i.value), ["mark lag", "mark baseline", "mark recovered"]);
  assert.deepEqual((await completeArguments("mark b"))!.map((i) => i.value), ["mark baseline"]);
  assert.deepEqual((await completeArguments("debug o"))!.map((i) => i.value), ["debug on", "debug off"]);
  assert.equal(await completeArguments("not-a-command"), null);
  assert.equal(await completeArguments("mark lag extra"), null);
  assert.equal(await completeArguments("status "), null);
});
