/**
 * Media fixture helpers for the REAL-PATH evaluation harness.
 *
 * materialize(root, spec) writes a tree whose keys are relative POSIX paths
 * (spaces and Unicode welcome, e.g. "tv/Serie Ñandú (2024)/Season 01/Serie Ñandú - S01E01.mkv"):
 *   { bytes: n, fill?: "pattern"|"zero" }  deterministic content derived from the path ("zero" = truncate, fast for big files)
 *   { text: "..." }                        UTF-8 text
 *   { srt: "..." }                         SubRip text (true → a default 3-cue file)
 *   { mkv: { seconds, withSrt?, subtitleCodec?: "srt"|"ass", width?, height?, audioLanguage?, subtitleLanguage? } }
 *                                          a REAL tiny video made by ffmpeg (testsrc + sine, mpeg4/aac,
 *                                          bit-exact); the container follows the extension (.mkv, .mp4);
 *                                          every file is unique (its path is written as the title tag)
 *   { hardlinkOf: "other/path" }           hard link to another entry of the same spec/root
 *   { symlinkTo: "target" }                symbolic link (may need Developer Mode on Windows)
 *   { dir: true }                          empty directory
 * Any entry may add `mtime` (ISO string or epoch ms).
 *
 * inventory(roots) lists every regular file and symlink (links are never
 * followed) with size, sha256, inode and link count, sorted; diffInventory()
 * compares two inventories.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let toolsChecked = null;

/**
 * Throws a clear error when ffmpeg or ffprobe is not runnable from PATH.
 * @returns {Promise<{ ffmpeg: string, ffprobe: string }>} first version line of each
 */
export async function assertMediaTools() {
  if (toolsChecked) return toolsChecked;
  const out = {};
  for (const tool of ['ffmpeg', 'ffprobe']) {
    try {
      const { stdout } = await execFileAsync(tool, ['-hide_banner', '-version'], { windowsHide: true, timeout: 15_000 });
      out[tool] = String(stdout).split(/\r?\n/)[0];
    } catch (err) {
      throw new Error(`${tool} is required by the evaluation harness but could not be run from PATH (${err?.code ?? err?.message ?? err}). Install ffmpeg 6+ and make sure both ffmpeg and ffprobe are on PATH.`);
    }
  }
  toolsChecked = out;
  return out;
}

function assertRelative(rel) {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error('media spec keys must be non-empty relative paths');
  const unified = rel.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) throw new Error(`media spec path must be relative: ${rel}`);
  const segments = unified.split('/').filter(Boolean);
  if (segments.some((s) => s === '..' || s === '.')) throw new Error(`media spec path must not contain . or ..: ${rel}`);
  return segments;
}

function absoluteFor(root, rel) {
  return path.join(root, ...assertRelative(rel));
}

function deterministicBytes(seed, n) {
  const out = Buffer.allocUnsafe(n);
  let offset = 0;
  let counter = 0;
  while (offset < n) {
    const block = crypto.createHash('sha256').update(seed).update(':').update(String(counter++)).digest();
    const take = Math.min(block.length, n - offset);
    block.copy(out, offset, 0, take);
    offset += take;
  }
  return out;
}

function defaultSrt(seconds = 3) {
  const cues = [];
  const n = Math.max(1, Math.floor(seconds));
  const ts = (s) => `00:00:${String(Math.floor(s)).padStart(2, '0')},${String(Math.round((s % 1) * 1000)).padStart(3, '0')}`;
  for (let i = 0; i < n; i++) cues.push(`${i + 1}\n${ts(i)} --> ${ts(Math.min(i + 0.9, seconds))}\nLínea de subtítulo ${i + 1}\n`);
  return cues.join('\n');
}

async function makeVideo(abs, rel, opts) {
  await assertMediaTools();
  const seconds = Math.max(1, Number(opts.seconds ?? 2));
  const width = opts.width ?? 160;
  const height = opts.height ?? 90;
  const ext = path.extname(abs).toLowerCase() || '.mkv';
  const isMp4 = ext === '.mp4' || ext === '.m4v' || ext === '.mov';
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'mbx-media-'));
  const tmpOut = path.join(work, `out${ext}`);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=10:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=${opts.frequency ?? 440}:sample_rate=44100:duration=${seconds}`,
  ];
  if (opts.withSrt) {
    const srtPath = path.join(work, 'sub.srt');
    await fsp.writeFile(srtPath, typeof opts.withSrt === 'string' ? opts.withSrt : defaultSrt(seconds), 'utf8');
    args.push('-i', srtPath);
  }
  args.push('-map', '0:v', '-map', '1:a');
  if (opts.withSrt) args.push('-map', '2:s');
  args.push('-c:v', 'mpeg4', '-q:v', '10', '-c:a', 'aac', '-b:a', '32k');
  if (opts.withSrt) args.push('-c:s', isMp4 ? 'mov_text' : (opts.subtitleCodec ?? 'srt'));
  args.push('-metadata', `title=${rel}`, '-metadata:s:a:0', `language=${opts.audioLanguage ?? 'spa'}`);
  if (opts.withSrt) args.push('-metadata:s:s:0', `language=${opts.subtitleLanguage ?? 'spa'}`);
  args.push('-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', tmpOut);
  try {
    await execFileAsync('ffmpeg', args, { windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    try {
      await fsp.rename(tmpOut, abs);
    } catch {
      await fsp.copyFile(tmpOut, abs);
    }
  } catch (err) {
    throw new Error(`ffmpeg could not generate ${rel}: ${err?.stderr || err?.message || err}`);
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function setMtime(abs, mtime) {
  if (mtime === undefined) return;
  const t = typeof mtime === 'number' ? new Date(mtime) : new Date(String(mtime));
  await fsp.utimes(abs, t, t);
}

/**
 * Materialises `spec` under `root` (created when missing).
 * @param {string} root
 * @param {Record<string, object>} spec
 * @returns {Promise<{ root: string, files: Record<string, string> }>} files maps each key to its absolute path
 */
export async function materialize(root, spec = {}) {
  await fsp.mkdir(root, { recursive: true });
  const entries = Object.entries(spec);
  const rank = (e) => (e.hardlinkOf ? 1 : e.symlinkTo ? 2 : 0);
  entries.sort((a, b) => rank(a[1]) - rank(b[1]));
  const files = {};
  for (const [rel, entry] of entries) {
    const abs = absoluteFor(root, rel);
    files[rel] = abs;
    if (!entry || typeof entry !== 'object') throw new Error(`media spec entry for ${rel} must be an object`);
    if (entry.dir) {
      await fsp.mkdir(abs, { recursive: true });
      await setMtime(abs, entry.mtime);
      continue;
    }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    if (entry.hardlinkOf) {
      await fsp.link(absoluteFor(root, entry.hardlinkOf), abs);
    } else if (entry.symlinkTo) {
      await fsp.symlink(entry.symlinkTo, abs);
      continue;
    } else if (entry.mkv || entry.video) {
      await makeVideo(abs, rel, entry.mkv ?? entry.video);
    } else if (entry.srt !== undefined) {
      await fsp.writeFile(abs, entry.srt === true ? defaultSrt(3) : String(entry.srt), 'utf8');
    } else if (entry.text !== undefined) {
      await fsp.writeFile(abs, String(entry.text), 'utf8');
    } else if (entry.bytes !== undefined) {
      const n = Math.max(0, Number(entry.bytes) || 0);
      if (entry.fill === 'zero') {
        const fh = await fsp.open(abs, 'w');
        try { await fh.truncate(n); } finally { await fh.close(); }
      } else {
        await fsp.writeFile(abs, deterministicBytes(rel, n));
      }
    } else {
      throw new Error(`media spec entry for ${rel} has no known kind (bytes|text|srt|mkv|hardlinkOf|symlinkTo|dir)`);
    }
    await setMtime(abs, entry.mtime);
  }
  return { root, files };
}

async function hashFile(abs) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(abs)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/**
 * Lists files and symlinks under each root without following links.
 * @param {string[] | Record<string, string>} roots array of directories, or { name: directory }
 * @returns {Promise<Array<{ root: string, path: string, type: "file"|"symlink", size: number,
 *   sha256: string|null, ino?: string, nlink?: number, mtimeMs?: number, target?: string }>>}
 */
export async function inventory(roots) {
  const pairs = Array.isArray(roots) ? roots.map((r) => [r, r]) : Object.entries(roots ?? {});
  const out = [];
  for (const [name, dir] of pairs) {
    async function walk(abs, rel) {
      let dirents;
      try {
        dirents = await fsp.readdir(abs, { withFileTypes: true });
      } catch (err) {
        if (err?.code === 'ENOENT') return;
        throw err;
      }
      for (const d of dirents) {
        const childAbs = path.join(abs, d.name);
        const childRel = rel ? `${rel}/${d.name}` : d.name;
        const st = await fsp.lstat(childAbs, { bigint: true });
        if (st.isSymbolicLink()) {
          out.push({ root: name, path: childRel, type: 'symlink', size: 0, sha256: null, target: await fsp.readlink(childAbs).catch(() => undefined) });
        } else if (st.isDirectory()) {
          await walk(childAbs, childRel);
        } else if (st.isFile()) {
          out.push({
            root: name,
            path: childRel,
            type: 'file',
            size: Number(st.size),
            sha256: await hashFile(childAbs),
            ino: st.ino ? st.ino.toString() : undefined,
            nlink: Number(st.nlink),
            mtimeMs: Number(st.mtimeMs),
          });
        }
      }
    }
    await walk(dir, '');
  }
  out.sort((a, b) => (a.root === b.root ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) : a.root < b.root ? -1 : 1));
  return out;
}

/**
 * Compares two inventories.
 * @returns {{ added: object[], removed: object[], changed: Array<{root:string,path:string,before:object,after:object}>,
 *   unchanged: number, moves: Array<{ from: object, to: object }> }}
 *   `moves` pairs a removed entry with an added one of identical sha256 (both stay listed in added/removed).
 */
export function diffInventory(before = [], after = []) {
  const key = (e) => `${e.root} ${e.path}`;
  const b = new Map(before.map((e) => [key(e), e]));
  const a = new Map(after.map((e) => [key(e), e]));
  const added = [];
  const removed = [];
  const changed = [];
  let unchanged = 0;
  for (const [k, e] of a) {
    const prev = b.get(k);
    if (!prev) added.push(e);
    else if (prev.sha256 !== e.sha256 || prev.size !== e.size || prev.type !== e.type) changed.push({ root: e.root, path: e.path, before: prev, after: e });
    else unchanged += 1;
  }
  for (const [k, e] of b) if (!a.has(k)) removed.push(e);
  const pool = [...added];
  const moves = [];
  for (const r of removed) {
    if (!r.sha256) continue;
    const idx = pool.findIndex((x) => x.sha256 === r.sha256 && x.size === r.size);
    if (idx >= 0) moves.push({ from: r, to: pool.splice(idx, 1)[0] });
  }
  return { added, removed, changed, unchanged, moves };
}
