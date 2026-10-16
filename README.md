# pi-perf

Low-noise process diagnostics for Pi, with opt-in continuous CPU/wall and sampled
heap profiling to Grafana Pyroscope. Designed for lag that grows over hours.

## Install

```sh
git clone https://github.com/slim-bean/pi-perf.git
cd pi-perf
npm ci --ignore-scripts
npm rebuild @datadog/pprof
pi install .
```

This registers your local checkout in Pi\u0027s personal settings. Run `/reload`
in an already-running session. Requires Node 22.19+.
Full smoke tests run against Pi 1.3.0; local collection is also verified in
Pi 1.2.0. Native profiling was tested on macOS ARM64 with Node 26.3. Other
platforms may need a compiler if the dependency has no matching prebuilt binary.

**Default: local diagnostics only.** Loading the package starts a 10-second
sampler. It does not load the native profiler, upload anything, open a listener,
read Pi credentials, or invoke a password manager. No periodic UI rendering.

## Commands

Press Tab after `/perf ` for subcommands, after `/perf mark ` for marker names,
and after `/perf debug ` for logging options.

- `/perf` or `/perf status`: latest sample, process/instance, log location,
  safe upload target, last upload result, counts, and optional scrape address.
- `/perf config`: inherited configuration and validation errors. Credentials
  are shown only as set/unset, never their values.
- `/perf check`: bounded TCP connectivity check (TLS too for HTTPS); sends no
  HTTP request, credentials, or profile. Does not verify Alloy-to-Cloud delivery.
- `/perf debug [on|off|status]`: best-effort per-upload records in the local
  rotating log. Off by default; `on` applies to subsequent attempts only.
- `/perf start`: start collection, using current environment configuration.
- `/perf stop`: release observers, histogram, timers, sockets, and profiling.
- `/perf mark [lag|baseline|recovered]`: timestamped marker; defaults to `lag`.
  Marker time is command execution, not physical keypress time.

A manual stop survives session changes in that extension runtime; `/reload`
re-evaluates the environment and starts again unless `PI_PERF_ENABLE=0`.
Session replacement/reload closes old resources before creating a new runtime.
Each runtime gets a fresh random `pi_instance` profile/metric label so concurrent
Pi processes and reset counters can be distinguished. It is not a session ID.
Local records call this same value `instance`.

## Continuous profiles

For a local Pyroscope server:

```sh
export PI_PERF_PROFILES=1
export PYROSCOPE_SERVER_ADDRESS=http://127.0.0.1:4040
pi
```

For Grafana Cloud Profiles, use the **Pyroscope endpoint and credentials** from
your stack (not the Grafana UI URL or OTLP endpoint):

```sh
export PI_PERF_PROFILES=1
export PYROSCOPE_SERVER_ADDRESS="https://YOUR-PYROSCOPE-ENDPOINT"
export PYROSCOPE_BASIC_AUTH_USER="YOUR-PROFILES-USER"
# Provide PYROSCOPE_BASIC_AUTH_PASSWORD through your normal secret mechanism.
# Do not commit the token or put it in Pi's settings/session.
pi
```

Only `PI_PERF_PROFILES=1` enables uploads; merely having standard Pyroscope
environment variables does not. Remote endpoints require HTTPS. SDK ingestion
uses `/ingest`; `service_name` is `pi`. Select CPU, wall, or heap in Profiles.
Labels include `pi_version`, `tui_mode`, `configuration`, and `pi_instance`.
Filter to one instance before comparing equal-length responsive/laggy windows.

`tui_mode` is Pi's **configured setting**, sampled when collection starts;
a CLI-only `--tui-mode` override can differ. Use
`PI_PERF_CONFIGURATION=regular-no-extensions` etc. to label controlled trials.
Restart collection after changing settings. Without other extensions:
`pi --no-extensions -e ~/projects/pi-extensions/pi-perf/src/index.ts`.

SDK 0.6.5 has no upload timeout option. A private, authenticated loopback relay
bounds uploads to two streaming requests, 32 MiB each, with a 5-second deadline.
There are no retries or queued profiles. Upload failures are counted, and local
diagnostics continue. Shutdown may take roughly 10 seconds if a current and a
final profile both time out. An unavailable backend should not build a backlog.
`PYROSCOPE_ADHOC_SERVER_ADDRESS` is rejected because it bypasses the relay.

Do not combine this with Node `--cpu-prof`, DevTools CPU recording, or another
in-process CPU profiler. `--cpu-prof` is detected and profiles are declined;
other profiler conflicts cannot all be detected.

## Troubleshooting profile delivery

1. Run `/perf config`. If variables are unset, use **export** in `~/.zshrc`:
   ```sh
   export PI_PERF_PROFILES=1
   export PYROSCOPE_SERVER_ADDRESS=http://127.0.0.1:9999
   ```
   Reload that shell configuration and launch a **new Pi process**. Extension
   reload cannot import a parent shell's new variables. Check `127`, not `129`.
2. Run `/perf check` to verify the configured host/port is reachable.
3. Run `/perf debug on`, wait one profile interval (60 seconds by default),
   then `/perf status`. Uploads are not immediate; a reachable port alone does
   not mean an upload has occurred. Debug logs do not force an upload.
4. Inspect the local log reported by `/perf status`. `profile_upload` records
   include timestamp, safe target, bytes, duration, HTTP status or allowlisted
   network code (`ECONNREFUSED`, `ENOTFOUND`, etc.), or `timeout`.
   HTTP 401/403 suggests authorization; 404 suggests endpoint/routing.
5. With Alloy, a successful upload means **Alloy accepted it**, not proof the
   Cloud backend stored it. Check Alloy's `pyroscope.write` logs and
   `pyroscope_write_sent_profiles_total` / dropped/retry metrics next.

Safe targets show the URL origin and `/ingest`; custom base paths are redacted.
Upload logs never include query parameters, request/response headers or bodies,
profile bytes, or raw exception text. The latest upload summary is retained
with debug off too. Slow disk writes can drop debug records (see drop count).
`/perf debug off` disables detailed records. Use `PI_PERF_DEBUG=1` before launch
to enable them from startup; an explicit debug command overrides that setting
within the current extension runtime, not across `/reload`.

## Local diagnostics

Logs: `~/.pi/agent/perf/pi-<pid>-<process-start>.jsonl` (or the configured agent
directory). Same file across session changes and reloads. Records contain
`start`, `sample`, `mark`, `stop`, and optional `debug`/`profile_upload` records;
no transcript content.

- Process uptime, CPU user/system totals, and CPU utilization (1 = one full core).
- Event-loop utilization and delay p50/p99/max in seconds, per sample window.
- RSS, V8 heap used/total, external and ArrayBuffer bytes.
- GC event count and total duration since collection started.
- Agent busy/idle, active-branch message count, session file size in bytes.
  Branch count scans only at startup/tree/compaction, not on every sample.
- Profile upload/failure counts and dropped log records.

Event-loop delay has **20 ms sampling resolution**: about 20 ms at idle is
normal; compare with your own baseline rather than treating that as a stall.
The startup sample covers a very short window; use subsequent samples.
GC observer delivery is asynchronous. Memory trends and sampled heap profiles
can suggest accumulation but do not prove a retained-object leak.

Files are mode 0600; a newly created log directory is 0700. Each process keeps
the current file plus two rotations, 10 MiB each by default. Slow disk writes
drop records instead of queuing. The extension retains only the latest sample
in memory. Logs from exited processes are preserved: periodically remove old
recordings yourself. Total disk use across all past processes is not capped.

## Prometheus / Alloy

Set `PI_PERF_METRICS_PORT=9078` to expose `http://127.0.0.1:9078/metrics`.
This is disabled by default. Set `0` for an automatically selected free port;
`/perf status` reports it. Multiple Pi processes need different ports.
Bind failure is reported but does not disable local collection.

A local Alloy scrape:

```alloy
prometheus.scrape "pi_perf" {
  targets = [{ "__address__" = "127.0.0.1:9078" }]
  scrape_interval = "10s"
  forward_to = [prometheus.remote_write.default.receiver]
}
```

Use your existing `prometheus.remote_write.default` configuration, or change
that reference. Metrics use `pi_instance` rather than `instance` to avoid
colliding with Prometheus's target label. Examples:

```promql
pi_perf_event_loop_delay_p99_seconds
pi_perf_cpu_ratio
pi_perf_heap_used_bytes
rate(pi_perf_gc_duration_seconds_total[5m])
increase(pi_perf_marks_total{kind="lag"}[1m])
```

All sample fields are exposed as `pi_perf_<field>`. Additional metrics:
`pi_perf_marks_total{kind}`, `pi_perf_profiles_active`,
`pi_perf_profile_uploads_total`, `pi_perf_profile_upload_failures_total`,
`pi_perf_log_dropped_total`, `pi_perf_log_errors`. HTTP uses loopback only;
another local process can read these metrics.

## Configuration

Environment is read at session start or `/perf start`. Changing your parent
shell environment does not change an already running Pi process.

| Variable | Default |
|---|---|
| `PI_PERF_ENABLE` | local collection on; `0` disables auto-start |
| `PI_PERF_DIR` | `<agent directory>/perf`; must be absolute |
| `PI_PERF_INTERVAL_MS` | `10000` (250–3600000) |
| `PI_PERF_LOG_MAX_BYTES` | `10485760` per file (1024–104857600) |
| `PI_PERF_PROFILES` | off; `1` enables native profiling/uploads |
| `PI_PERF_DEBUG` | off; `1` enables safe upload records from startup |
| `PI_PERF_PROFILE_INTERVAL_MS` | `60000` (10000–300000) |
| `PI_PERF_METRICS_PORT` | unset/off; `0` selects a free port |
| `PI_PERF_CONFIGURATION` | `normal`; short letters/digits/`_.-` label |
| `PYROSCOPE_SERVER_ADDRESS` | required when profiles enabled |
| `PYROSCOPE_BASIC_AUTH_USER` / `PYROSCOPE_BASIC_AUTH_PASSWORD` | optional; set both |
| `PYROSCOPE_TENANT_ID` | optional, for multi-tenant OSS |

Profile sampling: 100 Hz wall/CPU, heap sampling every ~512 KiB allocated,
maximum 64 heap stack frames. Profiling and serialization have overhead; compare
local-only versus profiles-enabled runs. Source mapping is not configured;
bundled Pi frames may point at bundled JS rather than original TypeScript.

## Privacy and limits

No prompts, keystrokes, message contents, tool arguments/results, session names,
session IDs, or project paths are included in local samples or metric labels.
Only branch counts and file sizes are observed. Marker values are a fixed enum.
Network errors are recorded as allowlisted codes, never raw SDK/network
exception strings. Explicit validation messages contain no input values.
Configuration/status diagnostics show only the endpoint origin, with custom
paths redacted and credentials/query parameters omitted.

**Profiles inherently contain function names and source paths** and may expose
private project/dependency names. Enable uploads only to a trusted destination.
No source files or heap snapshots are uploaded. Sampled heap profiles are
allocation-stack data, not complete object contents. Avoid SDK debug logging
while diagnosing private workloads.

This profiles the **Pi Node process**, not Ghostty, subprocesses, OS scheduling,
or full keypress-to-paint latency. Low loop delay with visible lag points us
toward terminal/OS behavior, but is not by itself proof. Heap snapshots, native
process samples, or terminal-side profiling may be needed next.

## Development

```sh
npm run typecheck
npm test
npm run test:pi
npm run test:pi -- --profiles  # native SDK inside Pi, ~12 seconds
node --import tsx scripts/soak.ts 60
```

Tests use loopback backends only. The Pi smoke test uses a fresh HOME and agent
directory, empty auth file, no inherited provider credentials, offline mode,
and explicit extensions only. It executes extension commands, never provider
prompts. It verifies lag detection, commands, config/connectivity diagnostics,
upload logging, metrics, reload, session replacement, and shutdown without
touching the user's auth file.

MIT.
