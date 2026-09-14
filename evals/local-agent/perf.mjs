/**
 * Performance evidence for P11 (PR05 §4.4): runtime process control, an
 * external memory supervisor, cold loads and media throughput under a frozen
 * inference load. Everything here observes the candidate from outside its
 * process; nothing is estimated or defaulted.
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export const PERF_VERSION = '1.0.0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal env for child processes: never inherit proxies or cloud keys. */
export function baseChildEnv(extra = {}) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ComSpec', 'PATHEXT', 'HOMEDRIVE', 'HOMEPATH', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

// ── Runtime process (Ollama) ───────────────────────────────────────────────

export class OllamaProcess {
  constructor({ exe, host = '127.0.0.1:11434', env = {}, logPath }) {
    this.exe = exe;
    this.host = host;
    this.baseUrl = `http://${host}`;
    this.env = env;
    this.logPath = logPath;
    this.child = null;
    this.startedAt = null;
  }

  async isHealthy() {
    try {
      const res = await fetch(`${this.baseUrl}/api/version`, { signal: AbortSignal.timeout(1_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async start() {
    // A runtime we just stopped can take a few seconds to release the port.
    for (let i = 0; i < 100 && (await this.isHealthy()); i++) await sleep(200);
    if (await this.isHealthy()) throw new Error(`Another runtime already answers on ${this.baseUrl}; stop it first so the experiment controls the process`);
    const out = fs.openSync(this.logPath, 'a');
    this.startedAt = performance.now();
    this.exitInfo = undefined;
    this.stopping = false;
    this.child = spawn(this.exe, ['serve'], {
      env: baseChildEnv({ OLLAMA_HOST: this.host, ...this.env }),
      stdio: ['ignore', out, out],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    // Only an exit the harness did not ask for counts as a crash/restart (§4.4).
    this.child.on('exit', (code, signal) => {
      if (!this.stopping) this.exitInfo = { code, signal, at: new Date().toISOString() };
    });
    return this.child.pid;
  }

  /** True when the runtime process died without the harness stopping it. */
  get crashed() {
    return Boolean(this.exitInfo);
  }

  async waitHealthy(timeoutMs = 120_000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) throw new Error(`runtime exited with ${this.child.exitCode}`);
      if (await this.isHealthy()) return performance.now();
      await sleep(100);
    }
    throw new Error(`runtime not healthy after ${timeoutMs} ms`);
  }

  async stop() {
    if (!this.child) return;
    this.stopping = true;
    const pid = this.child.pid;
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
    for (let i = 0; i < 100 && (await this.isHealthy()); i++) await sleep(200);
    // Worker processes the runtime spawned (model runners) must not survive a stop.
    for (const leftover of runtimePids()) {
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(leftover), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(leftover, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    this.child = null;
  }

  get pid() {
    return this.child?.pid ?? null;
  }
}

/** Kills any runtime process still answering (used before the controller takes over). */
export function runtimePids() {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', "Get-Process -Name 'ollama*','llama-server*' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }"], { encoding: 'utf8' });
      return out.split(/\s+/).filter(Boolean).map(Number);
    } catch {
      return [];
    }
  }
  try {
    return execFileSync('pgrep', ['-f', 'ollama|llama-server'], { encoding: 'utf8' }).split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

// ── External memory supervisor ─────────────────────────────────────────────

// The sampling loop is compiled C#: a PowerShell loop could not keep the
// ≤ 250 ms bound. Process and counter discovery (slow) runs on its own thread
// once per second; the tick only reads cached values.
const WIN_SAMPLER = String.raw`
param([int]$IntervalMs, [string]$OutPath)
$code = @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
public static class MbxSampler {
  public static void Run(int intervalMs, string outPath) {
    var cat = new PerformanceCounterCategory("GPU Process Memory");
    var sync = new object();
    var counters = new Dictionary<string, PerformanceCounter>();
    int[] ids = new int[0];
    var refresher = new Thread(() => {
      while (true) {
        try {
          // Ollama serves through a llama-server worker that holds the weights.
          var pids = new HashSet<int>(Process.GetProcessesByName("ollama").Concat(Process.GetProcessesByName("llama-server")).Select(p => p.Id));
          var fresh = new Dictionary<string, PerformanceCounter>();
          foreach (var name in cat.GetInstanceNames()) {
            var parts = name.Split('_');
            int pid;
            if (parts.Length > 1 && parts[0] == "pid" && int.TryParse(parts[1], out pid) && pids.Contains(pid)) {
              PerformanceCounter existing;
              lock (sync) { counters.TryGetValue(name, out existing); }
              fresh[name] = existing ?? new PerformanceCounter("GPU Process Memory", "Dedicated Usage", name, true);
            }
          }
          lock (sync) { counters = fresh; ids = pids.ToArray(); }
        } catch { }
        Thread.Sleep(1000);
      }
    });
    refresher.IsBackground = true;
    refresher.Start();
    var sw = Stopwatch.StartNew();
    using (var w = new StreamWriter(outPath, true)) {
      w.AutoFlush = true;
      while (true) {
        double t0 = sw.Elapsed.TotalMilliseconds;
        int[] cur; Dictionary<string, PerformanceCounter> cs;
        lock (sync) { cur = ids; cs = counters; }
        long ws = 0, priv = 0, vram = 0;
        foreach (var pid in cur) {
          try { using (var p = Process.GetProcessById(pid)) { ws += p.WorkingSet64; priv += p.PrivateMemorySize64; } } catch { }
        }
        foreach (var c in cs.Values) { try { vram += c.RawValue; } catch { } }
        w.WriteLine("{\"t\":" + t0.ToString("F1", CultureInfo.InvariantCulture) + ",\"ws\":" + ws + ",\"priv\":" + priv + ",\"vram\":" + vram + ",\"pids\":[" + string.Join(",", cur) + "]}");
        int wait = (int)Math.Max(0, intervalMs - (sw.Elapsed.TotalMilliseconds - t0));
        Thread.Sleep(wait);
      }
    }
  }
}
"@
Add-Type -TypeDefinition $code -ReferencedAssemblies System.Core
[MbxSampler]::Run($IntervalMs, $OutPath)
`;

/**
 * Starts a sampler process outside the candidate. Windows reads per-process
 * dedicated GPU memory (PDH "GPU Process Memory") and working set of every
 * runtime process; Linux reads RSS and the device VRAM counter.
 */
export function startMemorySampler({ intervalMs = 100, outPath }) {
  fs.writeFileSync(outPath, '');
  let child;
  if (process.platform === 'win32') {
    const script = path.join(path.dirname(outPath), 'memory-sampler.ps1');
    fs.writeFileSync(script, WIN_SAMPLER);
    child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-IntervalMs', String(intervalMs), '-OutPath', outPath], { stdio: 'ignore', windowsHide: true });
  } else {
    const script = path.join(path.dirname(outPath), 'memory-sampler.sh');
    fs.writeFileSync(script, `#!/bin/sh
start=$(date +%s%N)
while true; do
  now=$(date +%s%N); t=$(( (now - start) / 1000000 ))
  rss=0; pids=""
  for p in $(pgrep -f 'ollama|llama-server'); do r=$(awk '/VmRSS/ {print $2}' /proc/$p/status 2>/dev/null); rss=$((rss + \${r:-0} * 1024)); pids="$pids$p,"; done
  vram=0; for f in /sys/class/drm/card*/device/mem_info_vram_used; do [ -f "$f" ] && vram=$((vram + $(cat $f))); done
  echo "{\\"t\\":$t,\\"ws\\":$rss,\\"priv\\":$rss,\\"vram\\":$vram,\\"deviceWideVram\\":true,\\"pids\\":[\${pids%,}]}" >> "${outPath}"
  sleep 0.1
done
`);
    child = spawn('sh', [script], { stdio: 'ignore' });
  }
  return {
    child,
    async stop() {
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else child.kill('SIGKILL');
      } catch {
        // already stopped
      }
      await sleep(200);
      return summarizeMemorySamples(outPath, intervalMs);
    },
  };
}

export function summarizeMemorySamples(outPath, targetIntervalMs) {
  const lines = fs.readFileSync(outPath, 'utf8').split('\n').filter(Boolean);
  const samples = [];
  for (const line of lines) {
    try { samples.push(JSON.parse(line)); } catch { /* torn last line */ }
  }
  if (samples.length < 2) return { error: `only ${samples.length} memory samples`, samples: samples.length };
  const gaps = [];
  for (let i = 1; i < samples.length; i++) gaps.push(samples[i].t - samples[i - 1].t);
  gaps.sort((a, b) => a - b);
  const withRuntime = samples.filter((s) => (s.pids?.length ?? 0) > 0);
  return {
    source: process.platform === 'win32'
      ? 'PDH GPU Process Memory\\Dedicated Usage + WorkingSet64, summed over ollama and llama-server processes'
      : '/proc/<pid>/status VmRSS of ollama|llama-server + /sys/class/drm mem_info_vram_used (device-wide)',
    targetIntervalMs,
    samples: samples.length,
    samplesWithRuntime: withRuntime.length,
    durationMs: samples.at(-1).t - samples[0].t,
    maxSampleIntervalMs: Math.round(gaps.at(-1)),
    p99SampleIntervalMs: Math.round(gaps[Math.min(gaps.length - 1, Math.ceil(0.99 * gaps.length) - 1)]),
    peakRamBytes: Math.max(...samples.map((s) => s.ws ?? 0)),
    peakVramBytes: Math.max(...samples.map((s) => s.vram ?? 0)),
    deviceWideVram: samples.some((s) => s.deviceWideVram),
  };
}

// ── Media throughput under a frozen inference load ─────────────────────────

export function generateMediaFixture(outPath, { seconds = 60 } = {}) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=30`, '-t', String(seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', outPath]);
  return outPath;
}

/**
 * One transcode of the fixture with the declared profile. Returns frames per
 * second of wall time, or throws when ffmpeg fails (a failure is a result).
 */
export async function transcodeOnce(fixturePath, args) {
  const started = performance.now();
  const child = spawn('ffmpeg', ['-hide_banner', '-nostats', '-progress', 'pipe:1', ...args.pre, '-i', fixturePath, ...args.post, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let frames = 0;
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const m = line.match(/^frame=(\d+)/);
    if (m) frames = Number(m[1]);
  });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  const wallMs = performance.now() - started;
  if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`);
  return { frames, wallMs, fps: frames / (wallMs / 1000) };
}

/** Continuous streaming completions with a frozen prompt until `signal` aborts. */
export async function inferenceLoad({ baseUrl, model, prompt, maxTokens = 512, seed = 42, signal }) {
  let requests = 0;
  let completionTokens = 0;
  let failures = 0;
  while (!signal.aborted) {
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0, seed, max_tokens: maxTokens, stream: false }),
        signal,
      });
      const body = await res.json();
      requests++;
      completionTokens += body?.usage?.completion_tokens ?? 0;
    } catch (err) {
      if (!signal.aborted) failures++;
    }
  }
  return { requests, completionTokens, failures };
}

export function hostSnapshot() {
  return { platform: process.platform, arch: process.arch, cpus: os.cpus().length, totalmem: os.totalmem(), release: os.release() };
}
