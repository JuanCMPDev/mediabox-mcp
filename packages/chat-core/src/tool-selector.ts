import type { ChatMessage, VirtualToolDef } from './types.js';
import { VIRTUAL_TOOLS } from './virtual-tools.js';

/**
 * Pick the virtual tools relevant to the user's message and recent context.
 *
 * The chat prompt is intentionally rich, but exposing every high-level tool on
 * every turn makes the model juggle too many action enums, path formats, and
 * id spaces at once. This selector acts like a lightweight tool lens: keep the
 * UI helper available, add read tools for media/path grounding, and expose only
 * the service domains the current turn can reasonably need.
 */
export function selectTools(userMessage: string, history: ChatMessage[] = []): VirtualToolDef[] {
  const text = normalize(userMessage);
  const selected = new Set<string>();

  add(selected, 'present_choices');

  const continuation = continuationTools(text, history);
  if (continuation.length > 0) {
    for (const name of continuation) addWithCompanions(selected, name);
    return ordered(selected);
  }

  const serverIntent =
    /\b(server|servidor|health|salud|actividad|activity|sesion|sesiones|usuario|usuarios|users?|disk|disco|cpu|ram|overview)\b/.test(text) ||
    /^(estado|status)$/.test(text);

  const movieIntent =
    /\b(movie|movies|pelicula|peliculas|film|films|radarr|tmdb|tmdbid|movieid)\b/.test(text);

  const seriesIntent =
    /\b(series?|show|shows|anime|sonarr|tvdb|tvdbid|sonarrid|seriesid|episodeid|season|seasons|temporada|temporadas|episode|episodes|episodio|episodios|capitulo|capitulos|s\d{1,2}e\d{1,3})\b/.test(text);

  const downloadIntent =
    /\b(download|downloads|descarg\w*|baj\w*|torrent|torrents|release|releases|grab|seed|seeds|seeders|qbittorrent|qbit|pyload|mega|mediafire|gdrive|drive|url|urls?|link|links|enlace|enlaces|cola|queue|cancel|cancelar|purge|purgar|magnet)\b/.test(text) ||
    /\bhttps?:\/\/|\bwww\.|magnet:\?/.test(text);

  const fileIntent =
    /\b(file|files|archivo|archivos|folder|folders|carpeta|carpetas|ruta|rutas|path|paths|jellyfinitemid|library|biblioteca|scan|escane\w*|refresh|refresc\w*|metadata|metadatos|move|mover|mueve|moviendo|delete|borr\w*|elimin\w*|remove|quit\w*|rename|renombr\w*)\b/.test(text);

  const optimizeIntent =
    /\b(optimize|optimiz\w*|audio|audios|subtitle|subtitles|subtitul\w*|subs|track|tracks|pista|pistas|mkv|srt|ass|ssa|transcode|transcod\w*|ffmpeg)\b/.test(text);

  const maintenanceIntent =
    /\b(maintenance|mantenimiento|cleanup|clean|limpi\w*|cache|temp|tmp|orphan|orphans|huerfano|huerfanos|job|jobs|progreso|progress|background|fondo)\b/.test(text);

  const searchIntent =
    /\b(search|busc\w*|encuentr\w*|find|listar|lista|list|tengo|tenemos|exist\w*|hay|details|detalle|detalles|info|informacion|ver|add|agreg\w*|anad\w*|pon|poner|quiero|consigue|conseguir)\b/.test(text);

  const destructiveIntent =
    /\b(delete|borr\w*|elimin\w*|remove|quit\w*|replace|reemplaz\w*|sustitu\w*|redownload|redescarg\w*)\b/.test(text);

  if (serverIntent) add(selected, 'server_info');
  if (movieIntent) addWithCompanions(selected, 'movies');
  if (seriesIntent) addWithCompanions(selected, 'series');
  if (downloadIntent) addWithCompanions(selected, 'downloads');
  if (fileIntent || destructiveIntent) addWithCompanions(selected, 'library_ops');
  if (optimizeIntent) addWithCompanions(selected, 'optimize');
  if (maintenanceIntent) addWithCompanions(selected, 'maintenance');

  // "Download X" or "show releases for X" often needs Sonarr/Radarr first to
  // resolve ids, even when the user did not say movie vs series.
  if (downloadIntent && !movieIntent && !seriesIntent) {
    addWithCompanions(selected, 'movies');
    addWithCompanions(selected, 'series');
  }

  // "Do I have X?" / "find X" should search both local media and Arr catalogs.
  if (searchIntent && !serverIntent && !maintenanceIntent && !optimizeIntent) {
    add(selected, 'media_query');
    if (!movieIntent && !seriesIntent) {
      add(selected, 'movies');
      add(selected, 'series');
    }
  }

  // Cross-layer deletes/replacements need the Jellyfin item/path plus the Arr
  // side for verification or redownload.
  if (destructiveIntent) {
    add(selected, 'media_query');
    if (!movieIntent && !seriesIntent) {
      add(selected, 'movies');
      add(selected, 'series');
    }
  }

  return ordered(selected);
}

function normalize(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function add(selected: Set<string>, name: string): void {
  if (VIRTUAL_TOOLS[name]) selected.add(name);
}

function addWithCompanions(selected: Set<string>, name: string): void {
  add(selected, name);
  if (['movies', 'series', 'library_ops', 'optimize'].includes(name)) add(selected, 'media_query');
}

function ordered(selected: Set<string>): VirtualToolDef[] {
  return Object.keys(VIRTUAL_TOOLS)
    .filter(name => selected.has(name))
    .map(name => VIRTUAL_TOOLS[name]);
}

function continuationTools(text: string, history: ChatMessage[]): string[] {
  if (!isBareContinuation(text)) return [];

  const recent = new Set<string>();
  for (let i = history.length - 1, seen = 0; i >= 0 && seen < 10; i--, seen++) {
    for (const call of history[i].toolCalls ?? []) {
      if (call.name !== 'present_choices') recent.add(call.name);
    }
  }

  if (recent.size > 0) return [...recent];

  // No history is available in a few tests/consumers. Keep this rare fallback
  // broad enough that a yes/no confirmation can still be completed.
  return ['library_ops', 'movies', 'series', 'downloads', 'optimize', 'maintenance'];
}

function isBareContinuation(text: string): boolean {
  const compact = text.trim();
  if (compact.length === 0 || compact.length > 48) return false;
  return /^(si|yes|yep|ok|okay|dale|claro|correcto|confirmo|confirmar|procede|proceder|adelante|hazlo|aplica|apply|continue|continua|go ahead)$/i.test(compact);
}
