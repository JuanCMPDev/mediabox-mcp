/**
 * Deterministic fact extractor over `done.fullText` (PR05 §4.3).
 *
 * No LLM judge and no literal prose comparison: each scenario declares the
 * entities, values, states and negations its answer must contain (ES/EN
 * alternatives, anchored to fixture bindings) and the claims it must not make.
 * A missing mandatory fact or a contradicting claim fails the answer even when
 * the MCP call was correct.
 */

export const EXTRACTOR_VERSION = '2.0.0';

/** Lowercase, strip diacritics, unify quotes/dashes and collapse whitespace. */
export function normalizeText(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/[‐-―]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replaces {{name}} with the binding value; a missing binding is a harness error. */
export function resolveTemplate(value, bindings = {}) {
  return String(value).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => {
    if (!(key in bindings)) throw new Error(`Unresolved fact binding: ${key}`);
    return String(bindings[key]);
  });
}

/**
 * Finds the first occurrence of `alternative` in normalized text, bounded so
 * that "180" does not match inside "1800" and "plan" does not match "planned".
 * A trailing `*` makes it a stem ("encontr*" matches "encontré", "encontrado"),
 * which Spanish morphology needs; the start stays bounded.
 */
export function findAlternative(normalizedText, alternative) {
  const raw = String(alternative);
  const stem = raw.endsWith('*');
  const needle = normalizeText(stem ? raw.slice(0, -1) : raw);
  if (!needle) return null;
  const tail = stem ? '' : '(?![\\p{L}\\p{N}])';
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}${tail}`, 'u');
  const m = re.exec(normalizedText);
  return m ? { index: m.index, end: m.index + m[0].length } : null;
}

function firstMatch(normalizedText, alternatives, bindings, pattern) {
  let best = null;
  if (pattern) {
    // Declared regular expression over the normalized text (e.g. a size with a unit).
    const m = new RegExp(pattern, 'u').exec(normalizedText);
    if (m) best = { index: m.index, end: m.index + m[0].length, alternative: `/${pattern}/` };
  }
  for (const alt of alternatives ?? []) {
    const hit = findAlternative(normalizedText, resolveTemplate(alt, bindings));
    if (hit && (!best || hit.end < best.end)) best = { ...hit, alternative: alt };
  }
  return best;
}

/**
 * @param {string} text  assistant final text
 * @param {{required?: Array<{id:string, any:string[]}>, forbidden?: Array<{id:string, any:string[]}>}} rule
 * @param {Record<string, unknown>} bindings
 */
export function evaluateFacts(text, rule, bindings = {}) {
  const norm = normalizeText(text);
  const missing = [];
  const contradictions = [];
  const matched = [];
  if (!rule) return { ok: true, missing, contradictions, matched };

  for (const fact of rule.required ?? []) {
    const hit = firstMatch(norm, fact.any, bindings, fact.pattern);
    if (hit) matched.push({ id: fact.id, alternative: hit.alternative });
    else missing.push(fact.id);
  }
  for (const claim of rule.forbidden ?? []) {
    const hit = firstMatch(norm, claim.any, bindings, claim.pattern);
    if (hit) contradictions.push({ id: claim.id, alternative: hit.alternative });
  }
  return { ok: missing.length === 0 && contradictions.length === 0, missing, contradictions, matched };
}

/**
 * Normalized-text offset at which the first required fact becomes complete, or
 * null. Used to time the first factual fragment the user could see (§4.4).
 */
export function firstFactEnd(text, rule, bindings = {}) {
  const norm = normalizeText(text);
  let best = null;
  for (const fact of rule?.required ?? []) {
    const hit = firstMatch(norm, fact.any, bindings, fact.pattern);
    if (hit && (best === null || hit.end < best)) best = hit.end;
  }
  return best;
}

/** True when `text` already contains at least one required fact. */
export function containsAnyRequiredFact(text, rule, bindings = {}) {
  return firstFactEnd(text, rule, bindings) !== null;
}
