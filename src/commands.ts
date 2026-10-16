import type { RegisteredCommand } from "@earendil-works/pi-coding-agent";

export const help = "Usage: /perf status | config | check | debug [on|off|status] | start | stop | mark [lag|baseline|recovered]";
const commands = [
  ["status", "Latest process sample and upload result"],
  ["config", "Inherited configuration, without credentials"],
  ["check", "Check endpoint connectivity; sends no profiles"],
  ["debug", "Control safe per-upload logging"],
  ["start", "Start diagnostics"],
  ["stop", "Stop diagnostics and profiling"],
  ["mark", "Timestamp a lag, baseline, or recovery"],
];

export const completeArguments: NonNullable<RegisteredCommand["getArgumentCompletions"]> = (prefix) => {
  const text = prefix.trimStart();
  const parts = text.split(/\s+/);
  let items: Array<{ value: string; label: string; description?: string }> = [];
  if (parts.length === 1) {
    items = commands.filter(([value]) => value!.startsWith(text))
      .map(([value, description]) => ({ value: value!, label: value!, description }));
  } else if (parts.length === 2 && ["mark", "debug"].includes(parts[0]!)) {
    const options = parts[0] === "mark" ? ["lag", "baseline", "recovered"] : ["on", "off", "status"];
    items = options.filter((value) => value.startsWith(parts[1]!))
      .map((value) => ({ value: parts[0] + " " + value, label: value }));
  }
  return items?.length ? items : null;
};
