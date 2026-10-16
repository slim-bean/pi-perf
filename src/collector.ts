import { monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";

export interface Sample {
  timestamp: string;
  uptime_seconds: number;
  window_seconds: number;
  cpu_ratio: number;
  cpu_user_seconds_total: number;
  cpu_system_seconds_total: number;
  event_loop_utilization: number;
  event_loop_delay_p50_seconds: number;
  event_loop_delay_p99_seconds: number;
  event_loop_delay_max_seconds: number;
  rss_bytes: number;
  heap_used_bytes: number;
  heap_total_bytes: number;
  external_bytes: number;
  array_buffers_bytes: number;
  gc_count_total: number;
  gc_duration_seconds_total: number;
  busy: number;
  branch_messages: number;
  session_file_bytes: number;
}

export class Collector {
  private histogram = monitorEventLoopDelay({ resolution: 20 });
  private observer: PerformanceObserver;
  private previousTime = performance.now();
  private previousCpu = process.cpuUsage();
  private previousElu = performance.eventLoopUtilization();
  private gcCount = 0;
  private gcDuration = 0;
  private closed = false;

  constructor() {
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.gcCount++;
        this.gcDuration += entry.duration / 1000;
      }
    });
    this.observer.observe({ entryTypes: ["gc"] });
    this.histogram.enable();
  }

  sample(context: { busy: boolean; branchMessages: number; sessionFileBytes: number }): Sample {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const elapsedUs = Math.max(1, (now - this.previousTime) * 1000);
    const elu = performance.eventLoopUtilization();
    const deltaElu = performance.eventLoopUtilization(elu, this.previousElu);
    const memory = process.memoryUsage();
    const delay = (n: number) => this.histogram.count > 0 && Number.isFinite(n) ? n / 1e9 : 0;
    const sample: Sample = {
      timestamp: new Date().toISOString(),
      uptime_seconds: process.uptime(),
      window_seconds: elapsedUs / 1e6,
      cpu_ratio: ((cpu.user - this.previousCpu.user) + (cpu.system - this.previousCpu.system)) / elapsedUs,
      cpu_user_seconds_total: cpu.user / 1e6,
      cpu_system_seconds_total: cpu.system / 1e6,
      event_loop_utilization: deltaElu.utilization,
      event_loop_delay_p50_seconds: delay(this.histogram.percentile(50)),
      event_loop_delay_p99_seconds: delay(this.histogram.percentile(99)),
      event_loop_delay_max_seconds: delay(this.histogram.max),
      rss_bytes: memory.rss,
      heap_used_bytes: memory.heapUsed,
      heap_total_bytes: memory.heapTotal,
      external_bytes: memory.external,
      array_buffers_bytes: memory.arrayBuffers,
      gc_count_total: this.gcCount,
      gc_duration_seconds_total: this.gcDuration,
      busy: context.busy ? 1 : 0,
      branch_messages: context.branchMessages,
      session_file_bytes: context.sessionFileBytes,
    };
    this.previousTime = now;
    this.previousCpu = cpu;
    this.previousElu = elu;
    this.histogram.reset();
    return sample;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.histogram.disable();
    this.observer.disconnect();
  }
}
