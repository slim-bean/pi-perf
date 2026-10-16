# pi-perf

Read README.md for configuration and operating instructions.

- Start resources only in `session_start` or commands, never in the factory.
- Serialize lifecycle operations. Shutdown/reload must disable the event-loop
  histogram, disconnect the GC observer, clear timers, close HTTP, and stop SDK
  profiling. Never attach process-global signal handlers.
- No prompts, keypresses, tool payloads, session names/IDs, project paths, or
  arbitrary marker text in telemetry. Profiles inherently contain source paths.
- Local collection is the default; uploads and loopback scraping are opt-in.
  Never resolve Pi's auth file, shell credentials, or 1Password for tests.
- Keep only the latest sample in memory. Disk output rotates; a slow disk drops
  samples rather than accumulating a write queue. No per-stream-event scans,
  transcript serialization, periodic UI updates, or synchronous disk writes.
- Use the SDK's public API, isolate native loading, and preserve RPC stdout.
  Upload diagnostics may include only origin/redacted path, HTTP status,
  allowlisted error code, timing and size—not raw errors, URLs with credentials,
  query strings, headers, or bodies. Keep only one last-upload result in memory.
  Connectivity checks send no HTTP/auth/profile data. Do not run competing CPU
  profilers in tests.
- `npm test`, `npm run typecheck`, and `npm run test:pi` (isolated agent config,
  no provider call) are the checks. Native SDK tests use loopback only.
