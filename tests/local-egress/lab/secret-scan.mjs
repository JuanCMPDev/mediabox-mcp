/**
 * NET-05 scanner (PR05 §3.4): looks for canary secrets and unique conversation
 * phrases in logs, bundles, diagnostics and exportable reports, including the
 * escaped forms a leak usually takes (URL-encoded, JSON-escaped, base64).
 */
import fs from 'node:fs';
import path from 'node:path';

export function variants(secret) {
  const out = new Set([secret]);
  out.add(encodeURIComponent(secret));
  out.add(encodeURIComponent(secret).replace(/%20/g, '+'));
  out.add(JSON.stringify(secret).slice(1, -1));
  out.add(Buffer.from(secret, 'utf8').toString('base64').replace(/=+$/, ''));
  out.add(secret.normalize('NFD'));
  return [...out].filter((v) => v.length >= 6);
}

/** Returns [{ secret, variant, where }] for every hit. */
export function scanText(text, secrets, where) {
  const hits = [];
  for (const secret of secrets) {
    for (const v of variants(secret)) {
      if (text.includes(v)) hits.push({ secret, variant: v === secret ? 'literal' : v, where });
    }
  }
  return hits;
}

export function scanFiles(paths, secrets) {
  const hits = [];
  const walk = (p) => {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) walk(path.join(p, e));
    } else if (st.size < 32 * 1024 * 1024) {
      hits.push(...scanText(fs.readFileSync(p).toString('latin1'), secrets.map((s) => Buffer.from(s, 'utf8').toString('latin1')), p));
    }
  };
  for (const p of paths) walk(p);
  return hits;
}
