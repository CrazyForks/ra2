import { readFileSync } from 'node:fs';

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
/** 分开记录宿主可用量、容器用量和 OOM 计数，不将虚拟地址空间当作 RSS。 */
export function memorySnapshot() {
  const numeric = (path: string) => {
    const text = read(path).trim();
    return /^\d+$/.test(text) ? Number(text) : null;
  };
  const current = numeric('/sys/fs/cgroup/memory.current');
  const limit = numeric('/sys/fs/cgroup/memory.max');
  const peak = numeric('/sys/fs/cgroup/memory.peak');
  const events = read('/sys/fs/cgroup/memory.events');
  return {
    rssBytes: process.memoryUsage().rss,
    processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
    hostAvailableBytes: Number(read('/proc/meminfo').match(/^MemAvailable:\s+(\d+)/m)?.[1]) * 1024 || null,
    cgroupCurrentBytes: current,
    cgroupLimitBytes: limit,
    cgroupPeakBytes: peak,
    oomKills: events.match(/^oom_kill (\d+)/m)?.[1] ? Number(events.match(/^oom_kill (\d+)/m)![1]) : null,
  };
}
export function logMemory(stage: string): void {
  console.log(`[ci-memory] ${JSON.stringify({ stage, ...memorySnapshot() })}`);
}
