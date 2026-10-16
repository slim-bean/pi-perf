import { getAgentDir, VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describeConfig, readConfig, safeConfigError } from "./config.ts";
import { completeArguments, help } from "./commands.ts";
import { checkEndpoint } from "./upload-diagnostics.ts";
import { Diagnostics, type Marker } from "./service.ts";

export default function piPerf(pi: ExtensionAPI): void {
  let diagnostics: Diagnostics | undefined;
  let busy = false;
  let debugOverride: boolean | undefined;
  let startupError: string | undefined;
  let wanted = process.env.PI_PERF_ENABLE !== "0";
  let operations: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = operations.then(task, task);
    operations = next.catch(() => {});
    return next;
  };
  const notify = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(text, level);
  };
  const stop = async () => { await diagnostics?.stop(); };
  const start = async (ctx: ExtensionContext) => {
    if (diagnostics?.active) return;
    const config = readConfig(process.env, getAgentDir());
    config.debug = debugOverride ?? config.debug;
    diagnostics = new Diagnostics(config, {
      mode: () => ctx.mode === "tui" ? pi.getSettings().tuiMode ?? "fullscreen" : ctx.mode,
      sessionFile: () => ctx.sessionManager.getSessionFile(),
      branchMessages: () => ctx.sessionManager.getBranch().filter((e) => e.type === "message").length,
      busy: () => busy,
    }, VERSION);
    try { await diagnostics.start(); startupError = undefined; }
    catch { await diagnostics.stop(); throw new Error("Diagnostics startup failed"); }
  };

  pi.on("session_start", async (_event, ctx) => {
    busy = !ctx.isIdle();
    await enqueue(async () => {
      await stop();
      if (wanted) {
        try { await start(ctx); }
        catch (error) {
          startupError = safeConfigError(error);
          notify(ctx, "pi-perf could not start: " + startupError + " Use /perf config.", "warning");
        }
      }
    });
  });
  pi.on("session_shutdown", () => enqueue(stop));
  pi.on("agent_start", () => { busy = true; });
  pi.on("agent_settled", () => { busy = false; });
  pi.on("message_end", () => { diagnostics?.messageEnded(); });
  pi.on("session_tree", () => { diagnostics?.recount(); });
  pi.on("session_compact", () => { diagnostics?.recount(); });

  pi.registerCommand("perf", {
    description: "Local process diagnostics and opt-in Pyroscope profiling",
    getArgumentCompletions: completeArguments,
    handler: async (args, ctx) => {
      await enqueue(async () => {
        const parts = args.trim().split(/\s+/).filter(Boolean);
        const command = parts[0] || "status";
        try {
          if (command === "status" && parts.length <= 1) {
            notify(ctx, (diagnostics?.status() ?? "pi-perf: stopped. Use /perf start.") +
              (startupError ? "\nStartup error: " + startupError : ""));
          } else if (command === "config" && parts.length === 1) {
            notify(ctx, describeConfig() + (debugOverride !== undefined ? `\nRuntime debug override: ${debugOverride ? "on" : "off"}` : ""));
          } else if (command === "check" && parts.length === 1) {
            const config = readConfig();
            notify(ctx, config.serverAddress ? await checkEndpoint(config.serverAddress) :
              "No endpoint inherited by Pi. Use export PYROSCOPE_SERVER_ADDRESS=http://127.0.0.1:9999 before launching Pi. See /perf config.", "info");
          } else if (command === "debug" && parts.length <= 2) {
            const option = parts[1] || "status";
            if (!["on", "off", "status"].includes(option)) { notify(ctx, help, "warning"); return; }
            if (option !== "status") {
              debugOverride = option === "on";
              diagnostics?.setDebug(debugOverride);
            }
            notify(ctx, diagnostics?.debugStatus() ?? `Upload debug logging: ${debugOverride ?? (process.env.PI_PERF_DEBUG === "1") ? "on" : "off"} (applies on /perf start)`);
          } else if (command === "start" && parts.length === 1) {
            wanted = true;
            await start(ctx);
            notify(ctx, diagnostics!.status());
          } else if (command === "stop" && parts.length === 1) {
            wanted = false;
            await stop();
            notify(ctx, "pi-perf stopped; observers, timers, sockets, and profilers released.");
          } else if (command === "mark" && parts.length <= 2) {
            const kind = parts[1] || "lag";
            if (!["lag", "baseline", "recovered"].includes(kind)) { notify(ctx, help, "warning"); return; }
            if (!diagnostics?.active) { notify(ctx, "Use /perf start first.", "warning"); return; }
            await diagnostics.mark(kind as Marker);
            notify(ctx, `pi-perf ${kind} marker: ${new Date().toISOString()}`);
          } else notify(ctx, help, "warning");
        } catch (error) {
          const message = safeConfigError(error);
          if (command === "start") startupError = message;
          notify(ctx, message + " See /perf config and /perf status.", "error");
        }
      });
    },
  });
}
