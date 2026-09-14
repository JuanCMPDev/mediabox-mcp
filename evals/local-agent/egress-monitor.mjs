/**
 * External connection monitor for the lab run (PR05 §4.3 "observación externa
 * de red"). A sampler process outside the candidate lists the TCP connections
 * owned by the server and runtime processes every ~200 ms. An outbound
 * connection is allowed only to a loopback port the harness declared
 * (synthetic services, inference proxy, the server itself) or to a port a
 * monitored process listens on (the runtime's own worker). Everything else is
 * an egress violation.
 *
 * Limits, recorded in the evidence: sampling can miss a connection shorter
 * than one interval, and name resolution on Windows runs in the system DNS
 * client, not in the process. G09 (isolated Docker topology with a controlled
 * resolver and sink) remains the authoritative egress oracle.
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const WIN_MONITOR = String.raw`
param([string]$PidFile, [string]$OutPath, [int]$IntervalMs)
$ErrorActionPreference = 'SilentlyContinue'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$writer = [System.IO.StreamWriter]::new($OutPath, $true)
$writer.AutoFlush = $true
while ($true) {
  $t0 = $sw.Elapsed.TotalMilliseconds
  $ids = @()
  if (Test-Path $PidFile) { $ids += @(Get-Content $PidFile | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ }) }
  $ids += @(Get-Process -Name 'ollama*','llama-server*' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $conns = @()
  if ($ids.Count -gt 0) { $conns = @(Get-NetTCPConnection -OwningProcess $ids -ErrorAction SilentlyContinue) }
  $names = @{}
  foreach ($p in @(Get-Process -Id $ids -ErrorAction SilentlyContinue)) { $names[$p.Id] = $p.ProcessName }
  $items = foreach ($c in $conns) { '{"pid":' + $c.OwningProcess + ',"n":"' + $names[[int]$c.OwningProcess] + '","la":"' + $c.LocalAddress + '","lp":' + $c.LocalPort + ',"ra":"' + $c.RemoteAddress + '","rp":' + $c.RemotePort + ',"s":"' + $c.State + '"}' }
  $writer.WriteLine('{"t":' + [math]::Round($t0, 1) + ',"pids":[' + ($ids -join ',') + '],"c":[' + ($items -join ',') + ']}')
  $elapsed = $sw.Elapsed.TotalMilliseconds - $t0
  Start-Sleep -Milliseconds ([int][math]::Max(0, $IntervalMs - $elapsed))
}
`;

const LOOPBACK = /^(127\.|::1$|0:0:0:0:0:0:0:1$|::ffff:127\.)/;
const UNSPECIFIED = /^(0\.0\.0\.0|::|0:0:0:0:0:0:0:0)$/;

export function startEgressMonitor({ workDir, intervalMs = 200 }) {
  if (process.platform !== 'win32') {
    return { available: false, reason: 'the lab connection monitor is implemented for Windows; on Linux use G09', addPid() {}, removePid() {}, mark: () => performance.now(), window: () => ({ monitor: 'unavailable', disallowed: [] }), stop: async () => {} };
  }
  const pidFile = path.join(workDir, 'monitored-pids.txt');
  const outPath = path.join(workDir, 'connections.jsonl');
  const script = path.join(workDir, 'egress-monitor.ps1');
  fs.writeFileSync(pidFile, '');
  fs.writeFileSync(outPath, '');
  fs.writeFileSync(script, WIN_MONITOR);
  const origin = performance.now();
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-PidFile', pidFile, '-OutPath', outPath, '-IntervalMs', String(intervalMs)], { stdio: 'ignore', windowsHide: true });
  const pids = new Set();
  const writePids = () => fs.writeFileSync(pidFile, [...pids].join('\n'));

  function read() {
    return fs.readFileSync(outPath, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
  }

  return {
    available: true,
    addPid(pid) { pids.add(pid); writePids(); },
    removePid(pid) { pids.delete(pid); writePids(); },
    /** performance.now() of the harness; the monitor clock starts at `origin`. */
    mark: () => performance.now(),
    /**
     * Connections observed between two harness marks. `allowedLoopbackPorts`
     * lists the ports the scenario may reach.
     */
    /** Waits until the sampler has written a sample taken after `t` (harness clock). */
    async waitForSampleAfter(t, timeoutMs = 5_000) {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        if (read().some((s) => s.t + origin > t)) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    },
    window(t0, t1, { allowedLoopbackPorts = [], serverPid } = {}) {
      // One sample after the end is included so a sub-second scenario is still observed.
      const all = read();
      const after = all.find((s) => s.t + origin > t1);
      const samples = all.filter((s) => s.t + origin >= t0 && s.t + origin <= t1).concat(after ? [after] : []);
      if (samples.length < 1) return { monitor: 'failed', reason: 'no samples in window', disallowed: [] };
      if (serverPid && !samples.some((s) => s.pids.includes(serverPid))) return { monitor: 'failed', reason: 'server pid never sampled', disallowed: [] };
      const listening = new Set();
      for (const s of samples) for (const c of s.c) if (c.s === 'Listen') listening.add(c.lp);
      const allowed = new Set([...allowedLoopbackPorts, ...listening]);
      const seen = new Map();
      for (const s of samples) {
        for (const c of s.c) {
          if (c.s === 'Listen' || UNSPECIFIED.test(c.ra) || c.rp === 0) continue;
          if (listening.has(c.lp) && LOOPBACK.test(c.ra)) continue; // inbound to a monitored listener
          const ok = LOOPBACK.test(c.ra) && allowed.has(c.rp);
          if (!ok) seen.set(`${c.pid}|${c.ra}|${c.rp}`, { pid: c.pid, process: c.n, localPort: c.lp, remoteAddress: c.ra, remotePort: c.rp, state: c.s });
        }
      }
      const gaps = samples.slice(1).map((s, i) => s.t - samples[i].t);
      return { monitor: 'ok', samples: samples.length, maxGapMs: gaps.length ? Math.round(Math.max(...gaps)) : null, disallowed: [...seen.values()] };
    },
    async stop() {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    },
  };
}
