import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { checkEndpoint, formatUpload, networkCode, safeTarget } from "../src/upload-diagnostics.ts";
import { describeConfig } from "../src/config.ts";

test("endpoint and configuration diagnostics redact credentials, paths, and invalid values", () => {
  assert.equal(safeTarget("http://127.0.0.1:9999/"), "http://127.0.0.1:9999/ingest");
  assert.equal(safeTarget("https://user:secret@host/path-token?token=hidden#fragment"), "https://host/<redacted-path>/ingest");
  assert.equal(safeTarget("secret-invalid-url"), "(invalid HTTP URL)");
  const unset = describeConfig({});
  assert.match(unset, /unset \(profiles disabled\)/);
  assert.match(unset, /export/);
  const configured = describeConfig({
    PI_PERF_PROFILES: "1", PYROSCOPE_SERVER_ADDRESS: "https://user:secret@host/path-token?token=hidden",
    PYROSCOPE_BASIC_AUTH_USER: "private-user", PYROSCOPE_BASIC_AUTH_PASSWORD: "private-password",
  });
  assert.match(configured, /Configuration error:/);
  assert.doesNotMatch(configured, /secret|path-token|token=hidden|private-user|private-password/);
  assert.equal(networkCode(new Error("secret-error")), "network_error");
  assert.equal(networkCode({ cause: { code: "ECONNREFUSED", message: "secret" } }), "ECONNREFUSED");
  assert.equal(networkCode({ code: "secret-code" }), "network_error");
  assert.match(formatUpload(), /No upload/);
});

test("connectivity check sends no HTTP data and reports refusal without throwing", async () => {
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.end(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = "http://127.0.0.1:" + address.port;
  try {
    assert.match(await checkEndpoint(endpoint), /TCP connection succeeded/);
    assert.equal(requests, 0, "must not issue HTTP or submit profiles");
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
  assert.match(await checkEndpoint(endpoint), /ECONNREFUSED/);
  assert.match(await checkEndpoint("not-a-url"), /Invalid endpoint/);
  assert.match(await checkEndpoint("http://129.0.0.1:9999"), /Use HTTPS/);
});
