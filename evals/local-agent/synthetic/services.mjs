/**
 * Synthetic media-stack services for the REAL-PATH evaluation harness.
 *
 * One plain HTTP server per upstream service (Jellyfin, Sonarr, Radarr,
 * qBittorrent, Prowlarr, PyLoad, FlareSolverr) bound to 127.0.0.1:0. The
 * mcp-server talks to them through its own production clients
 * (packages/mcp-server/src/helpers/api.ts, qbittorrent.ts, pyload.ts), so every
 * response here mirrors the shape those clients and the tool handlers parse.
 *
 * Fidelity choices (deliberate, documented so scenario authors can rely on them):
 *  - Every JSON response carries `content-type: application/json` (the client
 *    returns `{status}` otherwise) and non-2xx makes the client throw.
 *  - Credentials are enforced on every request: Jellyfin `X-Emby-Token`, *arr
 *    `X-Api-Key` (or `apikey` query) → 401 when missing/wrong; qBittorrent needs
 *    the SID cookie from `auth/login` → 403 (what qBittorrent really answers and
 *    what the client re-logins on); PyLoad needs its session cookie → 401.
 *    Public endpoints: Jellyfin `/System/Info/Public`, qBit `auth/login`,
 *    PyLoad `/login`, FlareSolverr everything.
 *  - Jellyfin gates `Path`, `Overview`, `Genres`, `ProviderIds`, `MediaSources`,
 *    `OriginalTitle`, `Tags` behind the `Fields=` query parameter, like the real
 *    DTO service (disable with `options.jellyfinFieldGating = false`).
 *  - Jellyfin activity entries carry `UserId`, not `UserName` (real DTO), unless
 *    the seed puts `UserName` there explicitly.
 *  - Sonarr v4 series expose counts only under `statistics` (no top-level
 *    `episodeCount`/`episodeFileCount`/`seasonCount`) unless the seed sets them.
 *  - Sonarr/Radarr `queue` attaches `series`/`episode`/`movie` objects only when
 *    `includeSeries`/`includeEpisode`/`includeMovie=true`; default pageSize 10.
 *  - `POST /api/v3/release` only accepts a guid that a previous `GET release`
 *    returned within `options.releaseCacheTtlMs` (default 30 min), like the real
 *    release cache; otherwise 404. Set `options.requireReleaseCache = false` to
 *    accept any seeded guid.
 *
 * Grab behaviours (per seeded release, field `grabBehaviour`):
 *  - "ok" (default): 200; a queue record + a "grabbed" history record (stable
 *    downloadId = upper-case sha1(guid), `data.guid`) + a qBittorrent torrent appear.
 *  - "reject4xx": 400 validation error; nothing appears (→ plan `failed`).
 *  - "timeoutThenAppears": the connection is reset (or, when the release sets
 *    `grabHangMs`, the answer is delayed that long) and the queue/history records
 *    appear `appearAfterMs` (default 300) later (→ reconciled `succeeded`).
 *  - "never": the connection is reset and nothing ever appears (→ `unknown_outcome`).
 *  - "acceptNoTrace": 200 but nothing ever appears (→ the handler reports
 *    `submitted` without evidence).
 *
 * Fault injection: `setFault(service, matcher, fault)` where matcher is
 * `{ method?, path?: RegExp|string, url?: RegExp }`, a RegExp (tested against the
 * pathname) or a string (exact pathname); fault is any combination of
 * `{ delayMs, status, body, contentType, destroy: true|"immediate", times }`.
 * `destroy: true` sends the headers and a partial body then resets the socket;
 * `"immediate"` resets it before any byte. Faults apply before authentication.
 *
 * @typedef {object} JellyfinLibrary
 * @property {string} name
 * @property {"movies"|"tvshows"|"music"|"mixed"|"homevideos"} collectionType
 * @property {string} itemId            Library folder id (items use it as ParentId)
 * @property {string[]} locations        Container paths, e.g. ["/data/movies"]
 *
 * @typedef {object} JellyfinItem       Jellyfin BaseItemDto (PascalCase)
 * @property {string} Id
 * @property {string} Name
 * @property {"Movie"|"Series"|"Season"|"Episode"|"Audio"} Type
 * @property {number} [ProductionYear]
 * @property {string} [ParentId]         Defaults: library (Movie/Series), SeriesId (Season), SeasonId (Episode)
 * @property {string} [SeriesId]
 * @property {string} [SeasonId]
 * @property {string} [SeriesName]       Filled from SeriesId
 * @property {number} [IndexNumber]
 * @property {number} [ParentIndexNumber] Filled from the season for episodes
 * @property {string} [Path]             Container path ("/data/tv/...") — gated by Fields=Path
 * @property {string} [Overview]
 * @property {string[]} [Genres]
 * @property {number} [CommunityRating]
 * @property {boolean} [HasSubtitles]
 *
 * @typedef {object} SonarrSection
 * @property {string} [version]
 * @property {object[]} series           Sonarr SeriesResource (camelCase): {id,title,year,tvdbId,path,monitored,status,statistics?...}
 * @property {object[]} episodes         {id,seriesId,seasonNumber,episodeNumber,title,airDateUtc,hasFile,monitored}
 * @property {object[]} queue            {id,downloadId,title,seriesId,episodeId,size,sizeleft,status}
 * @property {object[]} history          {id,eventType,downloadId,sourceTitle,date,data:{guid}}
 * @property {Record<string, object[]>} releases  keys "series:<id>", "series:<id>:season:<n>", "episode:<id>" or "<seriesId>"
 * @property {object[]} lookup           lookup-only results (not in library); library series are always searchable too
 * @property {object[]} qualityProfiles  [{id,name}]
 *
 * @typedef {object} RadarrSection
 * @property {object[]} movies           Radarr MovieResource: {id,title,year,tmdbId,path,hasFile,monitored,status,sizeOnDisk}
 * @property {object[]} queue
 * @property {object[]} history
 * @property {Record<string, object[]>} releases  keys "<movieId>" or "movie:<id>"
 * @property {object[]} lookup
 * @property {object[]} qualityProfiles
 *
 * Release entries: {guid,title,size,seeders,leechers,indexerId,indexer,protocol,
 *   quality:{quality:{name,resolution}},languages:[{id,name}],customFormatScore,
 *   grabBehaviour?,appearAfterMs?,grabHangMs?} — the last three are harness options
 *   and are never returned to the client.
 *
 * @typedef {object} SyntheticSeed      JSON-serializable. Use buildSeed(partial).
 * @property {{serverName:string,version:string,operatingSystem?:string,serverId?:string,
 *   libraries:JellyfinLibrary[],items:JellyfinItem[],sessions:object[],users:object[],activity:object[]}} jellyfin
 * @property {SonarrSection} sonarr
 * @property {RadarrSection} radarr
 * @property {{version?:string,apiMajor?:4|5,torrents:object[]}} qbittorrent
 * @property {{version?:string,health?:object[]}} prowlarr
 * @property {{queue:object[],collector:object[],status?:object,downloads?:object[]}} pyload
 */
import http from 'node:http';
import crypto from 'node:crypto';

export const SERVICE_NAMES = Object.freeze(['jellyfin', 'sonarr', 'radarr', 'qbittorrent', 'prowlarr', 'pyload', 'flaresolverr']);
export const GRAB_BEHAVIOURS = Object.freeze(['ok', 'reject4xx', 'timeoutThenAppears', 'never', 'acceptNoTrace']);

const SEED_EPOCH = '2026-09-10T20:00:00.000Z';
const RELEASE_OPTION_KEYS = ['grabBehaviour', 'appearAfterMs', 'grabHangMs'];
const JELLYFIN_GATED_FIELDS = ['Path', 'Overview', 'Genres', 'ProviderIds', 'MediaSources', 'OriginalTitle', 'Tags'];

// ── small utilities ─────────────────────────────────────────────────────────

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const randomHex = (n = 16) => crypto.randomBytes(n).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** Case- and diacritic-insensitive normalisation used by every search. */
export function foldText(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function nextId(list) {
  return list.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1;
}

function stableId(prefix, ...parts) {
  return `${prefix}-${sha1(parts.join('|')).slice(0, 12)}`;
}

// ── seed defaults and normalisation ─────────────────────────────────────────

function defaultSeed() {
  return {
    jellyfin: {
      serverName: 'mediabox-synthetic',
      version: '10.10.7',
      operatingSystem: 'Linux',
      serverId: undefined,
      libraries: [
        { name: 'Movies', collectionType: 'movies', itemId: 'lib-movies', locations: ['/data/movies'] },
        { name: 'TV Shows', collectionType: 'tvshows', itemId: 'lib-tv', locations: ['/data/tv'] },
      ],
      items: [],
      sessions: [],
      users: [
        { Name: 'owner', Id: 'user-owner', Policy: { IsAdministrator: true }, LastActivityDate: SEED_EPOCH },
      ],
      activity: [],
    },
    sonarr: {
      version: '4.0.14.2939',
      series: [],
      episodes: [],
      queue: [],
      history: [],
      releases: {},
      lookup: [],
      qualityProfiles: [
        { id: 1, name: 'Any' },
        { id: 4, name: 'HD-1080p' },
        { id: 6, name: 'HD - 720p/1080p' },
      ],
      manualImport: [],
      commands: [],
      grabs: [],
    },
    radarr: {
      version: '5.26.2.10099',
      movies: [],
      queue: [],
      history: [],
      releases: {},
      lookup: [],
      qualityProfiles: [
        { id: 1, name: 'Any' },
        { id: 4, name: 'HD-1080p' },
        { id: 6, name: 'HD - 720p/1080p' },
      ],
      manualImport: [],
      commands: [],
      grabs: [],
    },
    qbittorrent: { version: 'v5.0.4', apiMajor: 5, torrents: [] },
    prowlarr: { version: '1.37.0.5076', health: [] },
    pyload: {
      queue: [],
      collector: [],
      downloads: [],
      status: { pause: false, active: 0, queue: 0, total: 0, speed: 0, download: true, reconnect: false, captcha: false },
    },
  };
}

function libraryForItem(libraries, item) {
  if (item.Path) {
    const hit = libraries.find((l) => (l.locations ?? []).some((loc) => item.Path === loc || item.Path.startsWith(`${loc}/`)));
    if (hit) return hit;
  }
  const wanted = item.Type === 'Movie' ? 'movies' : item.Type === 'Series' ? 'tvshows' : item.Type === 'Audio' ? 'music' : undefined;
  return libraries.find((l) => l.collectionType === wanted) ?? libraries[0];
}

function normalizeJellyfin(jf) {
  jf.serverId ??= sha1(jf.serverName).slice(0, 32);
  jf.libraries = (jf.libraries ?? []).map((l, i) => ({
    name: l.name ?? `Library ${i + 1}`,
    collectionType: l.collectionType ?? 'mixed',
    itemId: l.itemId ?? stableId('lib', l.name ?? i),
    locations: l.locations ?? [],
  }));
  const items = (jf.items ?? []).map((raw, i) => {
    const it = { ...raw };
    if (!it.Type) throw new Error(`jellyfin.items[${i}] needs a Type`);
    it.Name ??= it.Type === 'Season' && it.IndexNumber !== undefined ? `Season ${it.IndexNumber}` : `Item ${i + 1}`;
    it.Id ??= stableId('jf', it.Type, it.Name, i);
    return it;
  });
  const byId = new Map(items.map((it) => [it.Id, it]));
  for (const it of items) {
    if (it.Type === 'Season') {
      const series = byId.get(it.SeriesId);
      if (series) it.SeriesName ??= series.Name;
      it.ParentId ??= it.SeriesId;
      it.IsFolder ??= true;
    } else if (it.Type === 'Episode') {
      const series = byId.get(it.SeriesId);
      const season = byId.get(it.SeasonId);
      if (series) it.SeriesName ??= series.Name;
      if (season) {
        it.SeasonName ??= season.Name;
        it.ParentIndexNumber ??= season.IndexNumber;
      }
      it.ParentId ??= it.SeasonId ?? it.SeriesId;
      it.HasSubtitles ??= false;
      it.MediaType ??= 'Video';
      it.IsFolder ??= false;
    } else {
      it.ParentId ??= libraryForItem(jf.libraries, it)?.itemId;
      it.IsFolder ??= it.Type === 'Series';
      if (it.Type === 'Movie') it.MediaType ??= 'Video';
    }
    it.LocationType ??= 'FileSystem';
  }
  jf.items = items;
  jf.sessions = (jf.sessions ?? []).map((s, i) => ({
    Id: s.Id ?? stableId('session', i, s.UserName, s.DeviceName),
    Client: 'Jellyfin Web',
    LastActivityDate: SEED_EPOCH,
    ...s,
  }));
  jf.users = (jf.users ?? []).map((u, i) => ({ Id: u.Id ?? stableId('user', u.Name, i), Policy: { IsAdministrator: false }, ...u }));
  jf.activity = (jf.activity ?? []).map((a, i) => ({
    Id: a.Id ?? i + 1,
    Type: 'VideoPlayback',
    Severity: 'Information',
    Date: SEED_EPOCH,
    ...a,
  }));
  return jf;
}

function normalizeRelease(r, i) {
  return {
    guid: r.guid ?? `synthetic-guid-${i}`,
    title: r.title ?? `Synthetic.Release.${i}`,
    size: r.size ?? 1_500_000_000,
    seeders: r.seeders ?? 10,
    leechers: r.leechers ?? 1,
    protocol: r.protocol ?? 'torrent',
    indexer: r.indexer ?? 'SyntheticIndexer',
    indexerId: r.indexerId ?? 1,
    quality: r.quality ?? { quality: { name: 'WEBDL-1080p', resolution: 1080 } },
    languages: r.languages ?? [{ id: 1, name: 'English' }],
    customFormatScore: r.customFormatScore ?? 0,
    rejected: r.rejected ?? false,
    approved: r.approved ?? !(r.rejected ?? false),
    ageHours: r.ageHours ?? 12,
    ...r,
    grabBehaviour: r.grabBehaviour ?? 'ok',
  };
}

function normalizeReleases(map) {
  const out = {};
  let n = 0;
  for (const [key, list] of Object.entries(map ?? {})) {
    out[key] = (list ?? []).map((r) => normalizeRelease(r, n++));
    for (const r of out[key]) {
      if (!GRAB_BEHAVIOURS.includes(r.grabBehaviour)) throw new Error(`Unknown grabBehaviour '${r.grabBehaviour}' for ${r.guid}`);
    }
  }
  return out;
}

function normalizeQueue(list, entityKey) {
  return (list ?? []).map((q, i) => ({
    id: q.id ?? i + 1,
    downloadId: q.downloadId ?? sha1(`queue-${i}-${q.title}`).toUpperCase(),
    title: q.title ?? `Queued.Item.${i + 1}`,
    size: q.size ?? 1_000_000_000,
    sizeleft: q.sizeleft ?? q.size ?? 1_000_000_000,
    status: q.status ?? 'downloading',
    trackedDownloadStatus: q.trackedDownloadStatus ?? 'ok',
    trackedDownloadState: q.trackedDownloadState ?? 'downloading',
    protocol: q.protocol ?? 'torrent',
    downloadClient: q.downloadClient ?? 'qBittorrent',
    indexer: q.indexer ?? 'SyntheticIndexer',
    [entityKey]: q[entityKey],
    ...q,
  }));
}

function normalizeHistory(list) {
  return (list ?? []).map((h, i) => ({
    id: h.id ?? i + 1,
    eventType: h.eventType ?? 'grabbed',
    sourceTitle: h.sourceTitle ?? h.title ?? `History.Item.${i + 1}`,
    date: h.date ?? SEED_EPOCH,
    data: h.data ?? {},
    ...h,
  }));
}

function normalizeSonarr(s) {
  s.series = (s.series ?? []).map((x, i) => {
    const id = x.id ?? i + 1;
    const title = x.title ?? `Series ${id}`;
    return {
      id,
      title,
      sortTitle: foldText(title),
      year: x.year,
      tvdbId: x.tvdbId ?? 700000 + id,
      path: x.path ?? `/tv/${title}${x.year ? ` (${x.year})` : ''}`,
      rootFolderPath: x.rootFolderPath ?? '/tv',
      monitored: true,
      status: 'continuing',
      seriesType: 'standard',
      seasonFolder: true,
      qualityProfileId: 4,
      overview: '',
      added: SEED_EPOCH,
      titleSlug: foldText(title).replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
      ...x,
    };
  });
  s.episodes = (s.episodes ?? []).map((e, i) => ({
    id: e.id ?? 1000 + i + 1,
    seasonNumber: 1,
    title: `Episode ${e.episodeNumber ?? i + 1}`,
    airDate: (e.airDateUtc ?? SEED_EPOCH).slice(0, 10),
    airDateUtc: SEED_EPOCH,
    hasFile: false,
    monitored: true,
    ...e,
  }));
  for (const series of s.series) {
    const eps = s.episodes.filter((e) => e.seriesId === series.id);
    const seasonNumbers = [...new Set(eps.map((e) => e.seasonNumber))].sort((a, b) => a - b);
    series.seasons ??= seasonNumbers.map((n) => ({ seasonNumber: n, monitored: true }));
    series.statistics ??= {
      seasonCount: seasonNumbers.filter((n) => n > 0).length,
      episodeFileCount: eps.filter((e) => e.hasFile).length,
      episodeCount: eps.filter((e) => e.monitored || e.hasFile).length,
      totalEpisodeCount: eps.length,
      sizeOnDisk: eps.filter((e) => e.hasFile).reduce((sum, e) => sum + (e.sizeOnDisk ?? 0), 0),
      percentOfEpisodes: eps.length ? Math.round((eps.filter((e) => e.hasFile).length / eps.length) * 100) : 0,
    };
  }
  s.queue = normalizeQueue(s.queue, 'seriesId');
  s.history = normalizeHistory(s.history);
  s.releases = normalizeReleases(s.releases);
  s.lookup = (s.lookup ?? []).map((l, i) => ({ tvdbId: 800000 + i, status: 'continuing', seasons: [], ...l }));
  s.manualImport ??= [];
  s.commands ??= [];
  s.grabs ??= [];
  return s;
}

function normalizeRadarr(r) {
  r.movies = (r.movies ?? []).map((m, i) => {
    const id = m.id ?? i + 1;
    const title = m.title ?? `Movie ${id}`;
    return {
      id,
      title,
      sortTitle: foldText(title),
      year: m.year,
      tmdbId: m.tmdbId ?? 900000 + id,
      path: m.path ?? `/movies/${title}${m.year ? ` (${m.year})` : ''}`,
      rootFolderPath: m.rootFolderPath ?? '/movies',
      hasFile: false,
      monitored: true,
      status: 'released',
      minimumAvailability: 'released',
      qualityProfileId: 4,
      sizeOnDisk: 0,
      runtime: 100,
      overview: '',
      added: SEED_EPOCH,
      ...m,
    };
  });
  r.queue = normalizeQueue(r.queue, 'movieId');
  r.history = normalizeHistory(r.history);
  r.releases = normalizeReleases(r.releases);
  r.lookup = (r.lookup ?? []).map((l, i) => ({ tmdbId: 950000 + i, status: 'released', ...l }));
  r.manualImport ??= [];
  r.commands ??= [];
  r.grabs ??= [];
  return r;
}

function normalizeQbit(q) {
  q.torrents = (q.torrents ?? []).map((t, i) => ({
    hash: (t.hash ?? sha1(`torrent-${i}-${t.name}`)).toLowerCase(),
    name: t.name ?? `torrent-${i + 1}`,
    state: 'downloading',
    size: 1_000_000_000,
    progress: 0,
    dlspeed: 0,
    upspeed: 0,
    num_seeds: 5,
    num_leechs: 1,
    category: '',
    added_on: Math.floor(Date.parse(SEED_EPOCH) / 1000),
    ...t,
  }));
  return q;
}

/**
 * Fills defaults so scenarios only declare what matters. Idempotent and
 * deterministic: calling it on its own output returns an equal object.
 * @param {Partial<SyntheticSeed>} [partial]
 * @returns {SyntheticSeed}
 */
export function buildSeed(partial = {}) {
  const seed = deepMerge(defaultSeed(), clone(partial) ?? {});
  normalizeJellyfin(seed.jellyfin);
  normalizeSonarr(seed.sonarr);
  normalizeRadarr(seed.radarr);
  normalizeQbit(seed.qbittorrent);
  seed.prowlarr.health ??= [];
  return JSON.parse(JSON.stringify(seed));
}

// ── HTTP plumbing ───────────────────────────────────────────────────────────

function json(status, body, headers = {}) {
  return { status, body: JSON.stringify(body), contentType: 'application/json; charset=utf-8', headers };
}
function text(status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  return { status, body, contentType, headers };
}
function empty(status = 200, headers = {}) {
  return { status, body: '', contentType: undefined, headers };
}
const NOT_FOUND = (what) => json(404, { message: `NotFound: ${what}` });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const SECRET_KEY = /pass|token|secret|apikey|api_key/i;

function parseBody(raw, contentType) {
  if (!raw.length) return undefined;
  const str = raw.toString('utf8');
  if (/json/i.test(contentType ?? '')) {
    try { return JSON.parse(str); } catch { return str; }
  }
  if (/x-www-form-urlencoded/i.test(contentType ?? '')) {
    return Object.fromEntries(new URLSearchParams(str));
  }
  return str;
}

function redactForLog(body) {
  if (!isPlainObject(body)) return body;
  const out = {};
  for (const [k, v] of Object.entries(body)) out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : v;
  return out;
}

function queryObject(params) {
  const out = {};
  for (const [k, v] of params) {
    if (k in out) out[k] = Array.isArray(out[k]) ? [...out[k], v] : [out[k], v];
    else out[k] = v;
  }
  return out;
}

/** Case-insensitive query accessor (ASP.NET binds query parameters case-insensitively). */
function ciQuery(params) {
  const map = new Map();
  for (const [k, v] of params) if (!map.has(k.toLowerCase())) map.set(k.toLowerCase(), v);
  return (name) => map.get(name.toLowerCase());
}

function paginate(list, page, pageSize) {
  const p = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Number(pageSize) || 10);
  return { page: p, pageSize: size, totalRecords: list.length, records: list.slice((p - 1) * size, p * size) };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function stripReleaseOptions(r) {
  const out = { ...r };
  for (const k of RELEASE_OPTION_KEYS) delete out[k];
  return out;
}

// ── Jellyfin ────────────────────────────────────────────────────────────────

function jellyfinDto(item, fields, gating) {
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if (gating && JELLYFIN_GATED_FIELDS.includes(k) && !fields.has(k)) continue;
    out[k] = v;
  }
  if (fields.has('MediaSources') && item.Path && !item.MediaSources) {
    const container = item.Path.split('.').pop();
    out.MediaSources = [{ Id: item.Id, Path: item.Path, Protocol: 'File', Container: container, Type: 'Default' }];
  }
  return out;
}

function jellyfinRouter(ctx, env) {
  const { method, path } = ctx;
  const jf = env.state.jellyfin;
  const q = ciQuery(ctx.url.searchParams);
  const fields = new Set(String(q('Fields') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const gating = env.options.jellyfinFieldGating !== false;
  const dto = (it) => jellyfinDto(it, fields, gating);
  const byId = new Map(jf.items.map((it) => [it.Id, it]));
  const sortByName = (a, b) => String(a.SortName ?? a.Name).localeCompare(String(b.SortName ?? b.Name));

  if (method === 'GET' && path === '/System/Info') {
    return json(200, {
      ServerName: jf.serverName, Version: jf.version, OperatingSystem: jf.operatingSystem, Id: jf.serverId,
      ProductName: 'Jellyfin Server', LocalAddress: env.urls.jellyfin, StartupWizardCompleted: true,
      HasPendingRestart: false, IsShuttingDown: false, SupportsLibraryMonitor: true,
    });
  }
  if (method === 'GET' && path === '/Sessions') {
    return json(200, jf.sessions);
  }
  if (method === 'GET' && path === '/Users') return json(200, jf.users);
  if (method === 'GET' && path === '/Library/VirtualFolders') {
    return json(200, jf.libraries.map((l) => ({
      Name: l.name, CollectionType: l.collectionType, ItemId: l.itemId, Locations: l.locations,
      LibraryOptions: {}, RefreshStatus: 'Idle',
    })));
  }
  if (method === 'GET' && path === '/Items') {
    let items = jf.items.slice();
    const ids = q('ids');
    if (ids) {
      const wanted = ids.split(',').map((s) => s.trim());
      items = wanted.map((id) => byId.get(id)).filter(Boolean);
    }
    const parentId = q('ParentId');
    const recursive = String(q('Recursive')).toLowerCase() === 'true';
    if (parentId) {
      const descends = (it) => {
        let cur = it;
        for (let guard = 0; cur && guard < 16; guard++) {
          if (cur.ParentId === parentId) return true;
          if (!recursive) return false;
          cur = byId.get(cur.ParentId);
        }
        return false;
      };
      items = items.filter(descends);
    }
    const types = q('IncludeItemTypes');
    if (types) {
      const set = new Set(types.split(',').map((s) => s.trim().toLowerCase()));
      items = items.filter((it) => set.has(String(it.Type).toLowerCase()));
    }
    // Like Jellyfin's ItemsController: Years filters by ProductionYear before paging.
    const years = q('Years');
    if (years) {
      const wanted = new Set(String(years).split(',').map((s) => Number(s.trim())).filter(Number.isFinite));
      items = items.filter((it) => wanted.has(Number(it.ProductionYear)));
    }
    const term = q('searchTerm');
    if (term) {
      const t = foldText(term);
      items = items.filter((it) => foldText(it.Name).includes(t) || foldText(it.OriginalTitle).includes(t));
    }
    if (!ids) items.sort(sortByName);
    const total = items.length;
    const start = Math.max(0, Number(q('StartIndex')) || 0);
    const limit = q('Limit') !== undefined ? Math.max(0, Number(q('Limit')) || 0) : total;
    const page = items.slice(start, start + limit);
    return json(200, { Items: page.map(dto), TotalRecordCount: total, StartIndex: start });
  }
  let m;
  if (method === 'GET' && (m = path.match(/^\/Shows\/([^/]+)\/Seasons$/))) {
    const seriesId = decodeURIComponent(m[1]);
    if (!byId.has(seriesId)) return NOT_FOUND(`series ${seriesId}`);
    const seasons = jf.items.filter((it) => it.Type === 'Season' && it.SeriesId === seriesId)
      .sort((a, b) => (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0));
    return json(200, { Items: seasons.map(dto), TotalRecordCount: seasons.length, StartIndex: 0 });
  }
  if (method === 'GET' && (m = path.match(/^\/Shows\/([^/]+)\/Episodes$/))) {
    const seriesId = decodeURIComponent(m[1]);
    if (!byId.has(seriesId)) return NOT_FOUND(`series ${seriesId}`);
    const seasonId = q('SeasonId');
    const seasonNum = q('Season');
    let eps = jf.items.filter((it) => it.Type === 'Episode' && it.SeriesId === seriesId);
    if (seasonId) eps = eps.filter((e) => e.SeasonId === seasonId);
    if (seasonNum !== undefined) eps = eps.filter((e) => e.ParentIndexNumber === Number(seasonNum));
    eps.sort((a, b) => (a.ParentIndexNumber ?? 0) - (b.ParentIndexNumber ?? 0) || (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0));
    return json(200, { Items: eps.map(dto), TotalRecordCount: eps.length, StartIndex: 0 });
  }
  if (method === 'GET' && path === '/System/ActivityLog/Entries') {
    const start = Math.max(0, Number(q('startIndex')) || 0);
    const limit = q('limit') !== undefined ? Math.max(0, Number(q('limit')) || 0) : jf.activity.length;
    const sorted = jf.activity.slice().sort((a, b) => String(b.Date).localeCompare(String(a.Date)));
    return json(200, { Items: sorted.slice(start, start + limit), TotalRecordCount: jf.activity.length, StartIndex: start });
  }
  if (method === 'POST' && path === '/Library/Refresh') {
    env.state.jellyfin.refreshes = (env.state.jellyfin.refreshes ?? 0) + 1;
    return empty(204);
  }
  if (method === 'POST' && (m = path.match(/^\/Items\/([^/]+)\/Refresh$/))) {
    if (!byId.has(decodeURIComponent(m[1]))) return NOT_FOUND(`item ${m[1]}`);
    return empty(204);
  }
  if (method === 'POST' && path === '/Library/VirtualFolders') {
    const name = q('name');
    const loc = q('paths');
    jf.libraries.push({ name, collectionType: q('collectionType') ?? 'mixed', itemId: stableId('lib', name), locations: loc ? [loc] : [] });
    return empty(204);
  }
  if (method === 'POST' && (m = path.match(/^\/Sessions\/([^/]+)\/(Message|Playing\/Stop)$/))) {
    return empty(204);
  }
  return undefined;
}

// ── Sonarr / Radarr ─────────────────────────────────────────────────────────

function arrLookupPool(svc, section) {
  if (svc === 'sonarr') {
    const byTvdb = new Map(section.series.map((s) => [s.tvdbId, s]));
    const pool = section.series.map((s) => ({ ...s }));
    for (const l of section.lookup) {
      const lib = byTvdb.get(l.tvdbId);
      if (!lib) pool.push({ ...l });
    }
    return pool;
  }
  const byTmdb = new Map(section.movies.map((m) => [m.tmdbId, m]));
  const pool = section.movies.map((m) => ({ ...m }));
  for (const l of section.lookup) {
    if (!byTmdb.get(l.tmdbId)) pool.push({ ...l });
  }
  return pool;
}

function lookup(svc, section, term) {
  const pool = arrLookupPool(svc, section);
  const t = String(term ?? '').trim();
  const idMatch = t.match(/^(tvdb|tmdb|imdb):(\S+)$/i);
  if (idMatch) {
    const kind = idMatch[1].toLowerCase();
    const val = idMatch[2];
    return pool.filter((x) => (kind === 'imdb' ? x.imdbId === val : String(x[`${kind}Id`]) === val));
  }
  if (!t) return [];
  // Like the *arr/TMDB search: a trailing year narrows the results and the
  // remaining words must all appear in the title ("Marea Alta 2012").
  const words = foldText(t).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const years = words.filter((w) => /^(19|20)\d{2}$/.test(w));
  const rest = words.filter((w) => !years.includes(w));
  if (!rest.length) return [];
  const hits = pool.filter((x) => [x.title, x.originalTitle].some((title) => {
    const ft = foldText(title);
    return ft && rest.every((w) => ft.includes(w));
  }));
  if (!years.length) return hits;
  const byYear = hits.filter((x) => years.includes(String(x.year)));
  return byYear.length ? byYear : hits;
}

function releasesFor(svc, section, query) {
  const releases = section.releases;
  if (svc === 'sonarr') {
    const episodeId = query.get('episodeId');
    const seriesId = query.get('seriesId');
    const seasonNumber = query.get('seasonNumber');
    if (episodeId) return { key: `episode:${episodeId}`, list: releases[`episode:${episodeId}`] ?? [], entity: { episodeId: Number(episodeId), seriesId: section.episodes.find((e) => e.id === Number(episodeId))?.seriesId } };
    if (seriesId && seasonNumber !== null) {
      const key = `series:${seriesId}:season:${seasonNumber}`;
      return { key, list: releases[key] ?? releases[`series:${seriesId}`] ?? releases[seriesId] ?? [], entity: { seriesId: Number(seriesId) } };
    }
    if (seriesId) return { key: `series:${seriesId}`, list: releases[`series:${seriesId}`] ?? releases[seriesId] ?? [], entity: { seriesId: Number(seriesId) } };
    return { key: '', list: [], entity: {} };
  }
  const movieId = query.get('movieId');
  if (movieId) return { key: movieId, list: releases[movieId] ?? releases[`movie:${movieId}`] ?? [], entity: { movieId: Number(movieId) } };
  return { key: '', list: [], entity: {} };
}

function findSeededRelease(section, guid) {
  for (const [key, list] of Object.entries(section.releases)) {
    const r = list.find((x) => x.guid === guid);
    if (r) return { release: r, key };
  }
  return undefined;
}

function entityFromKey(svc, key, section) {
  if (svc === 'radarr') return { movieId: Number(String(key).replace(/^movie:/, '')) };
  let m;
  if ((m = String(key).match(/^episode:(\d+)$/))) {
    const ep = section.episodes.find((e) => e.id === Number(m[1]));
    return { episodeId: Number(m[1]), seriesId: ep?.seriesId };
  }
  if ((m = String(key).match(/^series:(\d+)/))) return { seriesId: Number(m[1]) };
  if (/^\d+$/.test(String(key))) return { seriesId: Number(key) };
  return {};
}

function materializeGrab(env, svc, release, entity, behaviour) {
  const section = env.state[svc];
  const downloadId = sha1(release.guid).toUpperCase();
  const now = new Date().toISOString();
  const entityFields = svc === 'sonarr'
    ? { seriesId: entity.seriesId, ...(entity.episodeId ? { episodeId: entity.episodeId } : {}) }
    : { movieId: entity.movieId };
  section.queue.push({
    id: nextId(section.queue),
    downloadId,
    title: release.title,
    ...entityFields,
    size: release.size,
    sizeleft: release.size,
    status: 'queued',
    trackedDownloadStatus: 'ok',
    trackedDownloadState: 'downloading',
    protocol: release.protocol,
    downloadClient: 'qBittorrent',
    indexer: release.indexer,
    quality: release.quality,
    languages: release.languages,
    added: now,
  });
  section.history.unshift({
    id: nextId(section.history),
    eventType: 'grabbed',
    sourceTitle: release.title,
    date: now,
    downloadId,
    ...entityFields,
    quality: release.quality,
    data: { guid: release.guid, indexer: release.indexer, indexerId: String(release.indexerId ?? ''), size: String(release.size), downloadClient: 'qBittorrent' },
  });
  env.state.qbittorrent.torrents.push({
    hash: downloadId.toLowerCase(),
    name: release.title,
    state: 'downloading',
    size: release.size,
    progress: 0,
    dlspeed: 0,
    upspeed: 0,
    num_seeds: release.seeders ?? 0,
    num_leechs: release.leechers ?? 0,
    category: svc === 'sonarr' ? 'tv-sonarr' : 'radarr',
    added_on: Math.floor(Date.now() / 1000),
  });
  const grab = section.grabs.find((g) => g.guid === release.guid && !g.materializedAt);
  if (grab) grab.materializedAt = now;
  env.emit('grab-materialized', { service: svc, guid: release.guid, downloadId, behaviour });
  return downloadId;
}

function arrRouter(svc, ctx, env) {
  const { method, path } = ctx;
  const section = env.state[svc];
  const query = ctx.url.searchParams;
  const entityKey = svc === 'sonarr' ? 'seriesId' : 'movieId';
  const libraryKey = svc === 'sonarr' ? 'series' : 'movie';
  const library = svc === 'sonarr' ? section.series : section.movies;
  if (!path.startsWith('/api/v3/')) return undefined;
  const ep = path.slice('/api/v3/'.length);
  let m;

  if (method === 'GET' && ep === 'system/status') {
    return json(200, {
      appName: svc === 'sonarr' ? 'Sonarr' : 'Radarr', instanceName: svc === 'sonarr' ? 'Sonarr' : 'Radarr',
      version: section.version, buildTime: SEED_EPOCH, isDebug: false, isProduction: true, isAdmin: false,
      isUserInteractive: false, startupPath: '/app/bin', appData: '/config', osName: 'ubuntu', isDocker: true,
      isLinux: true, isOsx: false, isWindows: false, branch: 'main', authentication: 'forms', urlBase: '',
      runtimeVersion: '8.0.12', runtimeName: '.NET',
    });
  }
  if (method === 'GET' && ep === 'health') return json(200, []);
  if (method === 'GET' && ep === 'rootfolder') {
    return json(200, [{ id: 1, path: svc === 'sonarr' ? '/tv' : '/movies', accessible: true, freeSpace: 500_000_000_000, unmappedFolders: [] }]);
  }
  if (method === 'GET' && ep === 'qualityprofile') return json(200, section.qualityProfiles);
  if (method === 'GET' && ep === `${libraryKey}/lookup`) return json(200, lookup(svc, section, query.get('term')));
  if (method === 'GET' && ep === libraryKey) return json(200, library);
  if ((m = ep.match(new RegExp(`^${libraryKey}/(\\d+)$`)))) {
    const id = Number(m[1]);
    const idx = library.findIndex((x) => x.id === id);
    if (idx < 0) return NOT_FOUND(`${libraryKey} ${id}`);
    if (method === 'GET') return json(200, library[idx]);
    if (method === 'PUT') {
      library[idx] = { ...library[idx], ...(isPlainObject(ctx.body) ? ctx.body : {}), id };
      return json(202, library[idx]);
    }
    if (method === 'DELETE') {
      const [removed] = library.splice(idx, 1);
      return json(200, removed ? {} : {});
    }
  }
  if (method === 'POST' && ep === libraryKey) {
    const body = isPlainObject(ctx.body) ? ctx.body : {};
    const created = { ...body, id: nextId(library), added: new Date().toISOString() };
    library.push(created);
    return json(201, created);
  }
  if (svc === 'sonarr' && method === 'GET' && ep === 'episode') {
    const seriesId = Number(query.get('seriesId'));
    return json(200, section.episodes.filter((e) => e.seriesId === seriesId)
      .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber));
  }
  if (svc === 'sonarr' && method === 'GET' && ep === 'calendar') {
    const start = Date.parse(query.get('start') ?? '') || 0;
    const end = Date.parse(query.get('end') ?? '') || Number.MAX_SAFE_INTEGER;
    const eps = section.episodes.filter((e) => {
      const t = Date.parse(e.airDateUtc);
      return t >= start && t <= end;
    }).map((e) => ({ ...e, series: section.series.find((s) => s.id === e.seriesId) }));
    return json(200, eps);
  }
  if (svc === 'sonarr' && method === 'GET' && ep === 'wanted/missing') {
    const now = Date.now();
    const missing = section.episodes
      .filter((e) => e.monitored && !e.hasFile && Date.parse(e.airDateUtc) <= now)
      .sort((a, b) => (query.get('sortDirection') === 'ascending' ? 1 : -1) * String(a.airDateUtc).localeCompare(String(b.airDateUtc)))
      .map((e) => ({ ...e, series: section.series.find((s) => s.id === e.seriesId) }));
    return json(200, { ...paginate(missing, query.get('page'), query.get('pageSize') ?? 10), sortKey: query.get('sortKey') ?? 'airDateUtc', sortDirection: query.get('sortDirection') ?? 'descending' });
  }
  if (method === 'GET' && ep === 'queue') {
    const withSeries = query.get('includeSeries') === 'true';
    const withEpisode = query.get('includeEpisode') === 'true';
    const withMovie = query.get('includeMovie') === 'true';
    const records = section.queue.map((r) => {
      const out = { ...r };
      if (svc === 'sonarr' && withSeries) out.series = section.series.find((s) => s.id === r.seriesId);
      if (svc === 'sonarr' && withEpisode && r.episodeId) out.episode = section.episodes.find((e) => e.id === r.episodeId);
      if (svc === 'radarr' && withMovie) out.movie = section.movies.find((x) => x.id === r.movieId);
      return out;
    });
    return json(200, { ...paginate(records, query.get('page'), query.get('pageSize') ?? 10), sortKey: 'timeleft', sortDirection: 'ascending' });
  }
  if (method === 'DELETE' && (ep === 'queue/bulk' || /^queue\/\d+$/.test(ep))) {
    const ids = ep === 'queue/bulk'
      ? (Array.isArray(ctx.body?.ids) ? ctx.body.ids.map(Number) : [])
      : [Number(ep.split('/')[1])];
    const removed = section.queue.filter((r) => ids.includes(r.id));
    if (ep !== 'queue/bulk' && removed.length === 0) return NOT_FOUND(`queue ${ids[0]}`);
    section.queue = section.queue.filter((r) => !ids.includes(r.id));
    if (query.get('removeFromClient') !== 'false') {
      const hashes = new Set(removed.map((r) => String(r.downloadId ?? '').toLowerCase()));
      env.state.qbittorrent.torrents = env.state.qbittorrent.torrents.filter((t) => !hashes.has(t.hash));
    }
    return empty(200);
  }
  if (method === 'GET' && ep === 'history') {
    const dir = query.get('sortDirection') === 'ascending' ? 1 : -1;
    const sorted = section.history.slice().sort((a, b) => dir * String(a.date).localeCompare(String(b.date)) || dir * (a.id - b.id));
    return json(200, { ...paginate(sorted, query.get('page'), query.get('pageSize') ?? 10), sortKey: query.get('sortKey') ?? 'date', sortDirection: dir === 1 ? 'ascending' : 'descending' });
  }
  if (method === 'GET' && ep === 'release') {
    const { key, list, entity } = releasesFor(svc, section, query);
    const now = Date.now();
    for (const r of list) env.releaseCache.set(`${svc}:${r.guid}`, { fetchedAt: now, key, entity });
    return json(200, list.map(stripReleaseOptions));
  }
  if (method === 'POST' && ep === 'release') {
    const guid = ctx.body?.guid;
    const indexerId = ctx.body?.indexerId;
    const cached = env.releaseCache.get(`${svc}:${guid}`);
    const ttl = env.options.releaseCacheTtlMs ?? 30 * 60 * 1000;
    const seeded = findSeededRelease(section, guid);
    const cacheOk = cached && Date.now() - cached.fetchedAt <= ttl;
    if (!seeded || (env.options.requireReleaseCache !== false && !cacheOk)) {
      section.grabs.push({ guid, indexerId, at: new Date().toISOString(), outcome: 'not_in_cache' });
      return json(404, { message: "Couldn't find requested release in cache, cache timeout probably expired." });
    }
    const release = seeded.release;
    const entity = cached?.entity && Object.keys(cached.entity).length ? cached.entity : entityFromKey(svc, seeded.key, section);
    const behaviour = release.grabBehaviour ?? 'ok';
    section.grabs.push({ guid, indexerId, at: new Date().toISOString(), behaviour, outcome: behaviour });
    switch (behaviour) {
      case 'ok':
        materializeGrab(env, svc, release, entity, behaviour);
        return json(200, stripReleaseOptions(release));
      case 'reject4xx':
        return json(400, [{ propertyName: 'Guid', errorMessage: `Release ${release.title} was rejected: download client refused the torrent`, severity: 'error' }]);
      case 'timeoutThenAppears': {
        const later = setTimeout(() => materializeGrab(env, svc, release, entity, behaviour), release.appearAfterMs ?? 300);
        env.timers.add(later);
        if (release.grabHangMs) return { delayMs: release.grabHangMs, then: json(200, stripReleaseOptions(release)) };
        return { destroyAfterMs: 100 };
      }
      case 'never':
        return { destroyAfterMs: 100 };
      case 'acceptNoTrace':
        return json(200, stripReleaseOptions(release));
      default:
        return json(500, { message: `unknown grabBehaviour ${behaviour}` });
    }
  }
  if (method === 'POST' && ep === 'command') {
    const body = isPlainObject(ctx.body) ? ctx.body : {};
    const cmd = { id: nextId(section.commands), name: body.name, commandName: body.name, status: 'queued', queued: new Date().toISOString(), trigger: 'manual', body };
    section.commands.push(cmd);
    return json(201, cmd);
  }
  if (ep === 'manualimport') {
    if (method === 'GET') return json(200, section.manualImport);
    if (method === 'POST') return json(202, {});
  }
  return undefined;
}

// ── Prowlarr ────────────────────────────────────────────────────────────────

function prowlarrRouter(ctx, env) {
  const { method, path } = ctx;
  if (method === 'GET' && path === '/api/v1/system/status') {
    return json(200, { appName: 'Prowlarr', instanceName: 'Prowlarr', version: env.state.prowlarr.version, isDocker: true, authentication: 'forms', urlBase: '' });
  }
  if (method === 'GET' && path === '/api/v1/health') return json(200, env.state.prowlarr.health ?? []);
  if (method === 'GET' && path === '/api/v1/indexer') return json(200, env.state.prowlarr.indexers ?? []);
  return undefined;
}

// ── qBittorrent ─────────────────────────────────────────────────────────────

function qbitRouter(ctx, env) {
  const { method, path } = ctx;
  const qb = env.state.qbittorrent;
  if (!path.startsWith('/api/v2/')) return undefined;
  const ep = path.slice('/api/v2/'.length);
  const form = isPlainObject(ctx.body) ? ctx.body : {};
  if (method === 'GET' && ep === 'app/version') return text(200, qb.version);
  if (method === 'GET' && ep === 'app/webapiVersion') return text(200, qb.apiMajor >= 5 ? '2.11.2' : '2.9.3');
  if (method === 'GET' && ep === 'transfer/info') {
    return json(200, { connection_status: 'connected', dl_info_speed: qb.torrents.reduce((s, t) => s + (t.dlspeed ?? 0), 0), up_info_speed: 0, dl_info_data: 0, up_info_data: 0, dht_nodes: 100 });
  }
  if (method === 'GET' && ep === 'torrents/info') {
    let list = qb.torrents;
    const hashes = ctx.url.searchParams.get('hashes');
    if (hashes) {
      const set = new Set(hashes.toLowerCase().split('|'));
      list = list.filter((t) => set.has(t.hash));
    }
    const category = ctx.url.searchParams.get('category');
    if (category !== null) list = list.filter((t) => t.category === category);
    // WebUI API paging: sort/reverse, then offset (negative counts from the end) and limit (<= 0: all).
    const sort = ctx.url.searchParams.get('sort');
    if (sort) list = [...list].sort((a, b) => (a[sort] < b[sort] ? -1 : a[sort] > b[sort] ? 1 : 0));
    if (ctx.url.searchParams.get('reverse') === 'true') list = [...list].reverse();
    const offset = Number(ctx.url.searchParams.get('offset') ?? 0) || 0;
    const limit = Number(ctx.url.searchParams.get('limit') ?? 0) || 0;
    const start = offset < 0 ? Math.max(0, list.length + offset) : offset;
    list = list.slice(start, limit > 0 ? start + limit : undefined);
    return json(200, list);
  }
  if (method === 'POST' && ep === 'torrents/delete') {
    const set = new Set(String(form.hashes ?? '').toLowerCase().split('|'));
    qb.torrents = form.hashes === 'all' ? [] : qb.torrents.filter((t) => !set.has(t.hash));
    return empty(200);
  }
  const v5 = (qb.apiMajor ?? 5) >= 5;
  const toggles = v5 ? { 'torrents/stop': 'stoppedDL', 'torrents/start': 'downloading' } : { 'torrents/pause': 'pausedDL', 'torrents/resume': 'downloading' };
  if (method === 'POST' && toggles[ep]) {
    const set = new Set(String(form.hashes ?? '').toLowerCase().split('|'));
    for (const t of qb.torrents) if (form.hashes === 'all' || set.has(t.hash)) t.state = toggles[ep];
    return empty(200);
  }
  return undefined;
}

// ── PyLoad ──────────────────────────────────────────────────────────────────

function pyloadHtml(csrf) {
  return `<!doctype html><html><head><meta name="csrf-token" content="${csrf}"><title>pyLoad</title></head><body>pyLoad synthetic</body></html>`;
}

function pyloadRouter(ctx, env) {
  const { method, path } = ctx;
  const py = env.state.pyload;
  if (!path.startsWith('/api/')) return undefined;
  const methodName = path.slice('/api/'.length);
  const form = isPlainObject(ctx.body) ? ctx.body : {};
  switch (methodName) {
    case 'get_queue': return json(200, py.queue);
    case 'get_collector': return json(200, py.collector);
    case 'statusServer': return json(200, { ...py.status, queue: py.queue.length, total: py.queue.length + py.collector.length });
    case 'statusDownloads': return json(200, py.downloads ?? []);
    case 'add_package': {
      const pid = nextId(py.queue.map((p) => ({ id: p.pid })).concat(py.collector.map((p) => ({ id: p.pid }))));
      let name = form.name;
      let links = [];
      try { name = JSON.parse(form.name); } catch { /* keep raw */ }
      try { links = JSON.parse(form.links); } catch { links = []; }
      py.queue.push({ pid, name, folder: name, site: '', password: '', dest: 1, order: py.queue.length, linksdone: 0, sizedone: 0, sizetotal: 0, linkstotal: links.length, links });
      return json(200, pid);
    }
    case 'deletePackages': {
      const ids = new Set((ctx.body?.package_ids ?? []).map(Number));
      py.queue = py.queue.filter((p) => !ids.has(p.pid));
      py.collector = py.collector.filter((p) => !ids.has(p.pid));
      return json(200, true);
    }
    default:
      return undefined;
  }
}

// ── FlareSolverr ────────────────────────────────────────────────────────────

function flaresolverrRouter(ctx) {
  const { method, path } = ctx;
  if (method === 'GET' && (path === '/health' || path === '/')) {
    return json(200, { msg: 'FlareSolverr is ready!', version: '3.3.21', userAgent: 'Mozilla/5.0 (synthetic)' });
  }
  if (method === 'POST' && path === '/v1') {
    return json(200, { status: 'ok', message: 'Challenge not detected!', solution: { url: ctx.body?.url ?? '', status: 200, response: '<html></html>', cookies: [], userAgent: 'Mozilla/5.0 (synthetic)' }, startTimestamp: Date.now(), endTimestamp: Date.now(), version: '3.3.21' });
  }
  return undefined;
}

// ── authentication per service ──────────────────────────────────────────────

function authenticate(service, ctx, env) {
  const { req, path, method } = ctx;
  const k = env.keys;
  switch (service) {
    case 'jellyfin': {
      if (method === 'GET' && path === '/System/Info/Public') return { public: true };
      const token = req.headers['x-emby-token'] ?? req.headers['x-mediabrowser-token'] ?? ctx.url.searchParams.get('api_key');
      return token === k.JELLYFIN_API_KEY ? null : json(401, { message: 'Unauthorized' });
    }
    case 'sonarr':
    case 'radarr':
    case 'prowlarr': {
      const expected = { sonarr: k.SONARR_API_KEY, radarr: k.RADARR_API_KEY, prowlarr: k.PROWLARR_API_KEY }[service];
      const token = req.headers['x-api-key'] ?? ctx.url.searchParams.get('apikey');
      return token === expected ? null : json(401, { message: 'Unauthorized' });
    }
    case 'qbittorrent': {
      if (path === '/api/v2/auth/login') return { public: true };
      const sid = parseCookies(req.headers.cookie).SID;
      return sid && env.qbitSessions.has(sid) ? null : text(403, 'Forbidden');
    }
    case 'pyload': {
      if (path === '/login') return { public: true };
      const sid = parseCookies(req.headers.cookie).session;
      if (sid && env.pyloadSessions.has(sid)) return null;
      if (path === '/dashboard') return empty(302, { location: '/login' });
      return json(401, { error: 'Unauthorized' });
    }
    default:
      return null;
  }
}

/** Login handshakes that are answered before routing. */
function handshake(service, ctx, env) {
  const { method, path } = ctx;
  if (service === 'qbittorrent' && path === '/api/v2/auth/login') {
    if (method !== 'POST') return text(405, 'Method Not Allowed');
    const form = isPlainObject(ctx.body) ? ctx.body : {};
    if (form.username === env.keys.QBIT_USER && form.password === env.keys.QBIT_PASSWORD) {
      const sid = randomHex(16);
      env.qbitSessions.add(sid);
      return text(200, 'Ok.', 'text/plain; charset=UTF-8', { 'set-cookie': `SID=${sid}; HttpOnly; SameSite=Strict; path=/` });
    }
    return text(200, 'Fails.');
  }
  if (service === 'pyload' && path === '/login') {
    const csrf = randomHex(8);
    if (method === 'GET') {
      return text(200, pyloadHtml(csrf), 'text/html; charset=utf-8', { 'set-cookie': `session=pre-${randomHex(8)}; HttpOnly; Path=/` });
    }
    const form = isPlainObject(ctx.body) ? ctx.body : {};
    if (form.username === env.keys.PYLOAD_USER && form.password === env.keys.PYLOAD_PASSWORD) {
      const sid = randomHex(16);
      env.pyloadSessions.add(sid);
      return empty(302, { location: '/dashboard', 'set-cookie': `session=${sid}; HttpOnly; Path=/` });
    }
    return text(200, pyloadHtml(csrf), 'text/html; charset=utf-8');
  }
  if (service === 'pyload' && path === '/dashboard' && method === 'GET') {
    const sid = parseCookies(ctx.req.headers.cookie).session;
    if (sid && env.pyloadSessions.has(sid)) return text(200, pyloadHtml(randomHex(8)), 'text/html; charset=utf-8');
  }
  return undefined;
}

const ROUTERS = {
  jellyfin: jellyfinRouter,
  sonarr: (ctx, env) => arrRouter('sonarr', ctx, env),
  radarr: (ctx, env) => arrRouter('radarr', ctx, env),
  prowlarr: prowlarrRouter,
  qbittorrent: qbitRouter,
  pyload: pyloadRouter,
  flaresolverr: flaresolverrRouter,
};

// ── faults ──────────────────────────────────────────────────────────────────

function compileMatcher(matcher) {
  if (matcher instanceof RegExp) return { path: matcher };
  if (typeof matcher === 'string') return { path: matcher };
  if (isPlainObject(matcher)) return matcher;
  if (matcher === undefined || matcher === null) return {};
  throw new Error('fault matcher must be a RegExp, a string or { method?, path?, url? }');
}

function matcherHits(m, method, path, fullUrl) {
  if (m.method && String(m.method).toUpperCase() !== method) return false;
  if (m.path instanceof RegExp && !m.path.test(path)) return false;
  if (typeof m.path === 'string' && m.path !== path) return false;
  if (m.url instanceof RegExp && !m.url.test(fullUrl)) return false;
  return true;
}

// ── server ──────────────────────────────────────────────────────────────────

/**
 * Starts the synthetic services (all of them by default) on `host`:`ports[service]`.
 * @param {Partial<SyntheticSeed>} [seed]
 * @param {{
 *   host?: string,                      bind address (default 127.0.0.1; "0.0.0.0" inside containers)
 *   advertiseHost?: string,             hostname used in the returned URLs (default: host, or 127.0.0.1 for 0.0.0.0/::)
 *   ports?: Partial<Record<string, number>>, fixed port per service; 0/omitted = random
 *   only?: string[],                    subset of SERVICE_NAMES to start (urls of the others are undefined)
 *   keys?: object,                      override any generated credential
 *   onRequest?: (entry: object) => void, called once per request after its status is known
 *   jellyfinFieldGating?: boolean, requireReleaseCache?: boolean, releaseCacheTtlMs?: number,
 *   latencyMs?: number | Record<string, number>
 * }} [options]
 */
export async function startSyntheticServices(seed = {}, options = {}) {
  const state = buildSeed(seed);
  const keys = {
    JELLYFIN_API_KEY: `jf-${randomHex(12)}`,
    SONARR_API_KEY: randomHex(16),
    RADARR_API_KEY: randomHex(16),
    PROWLARR_API_KEY: randomHex(16),
    QBIT_USER: 'admin',
    QBIT_PASSWORD: `qb-${randomHex(8)}`,
    PYLOAD_USER: 'pyload',
    PYLOAD_PASSWORD: `py-${randomHex(8)}`,
    ...(options.keys ?? {}),
  };
  const host = options.host ?? '127.0.0.1';
  const requestLog = [];
  const faults = [];
  const listeners = new Map();
  const env = {
    state,
    keys,
    options,
    urls: {},
    releaseCache: new Map(),
    qbitSessions: new Set(),
    pyloadSessions: new Set(),
    timers: new Set(),
    emit(event, payload) {
      for (const fn of listeners.get(event) ?? []) {
        try { fn(payload); } catch { /* listener errors never break a response */ }
      }
    },
  };
  let seq = 0;
  let faultSeq = 0;

  const latencyFor = (service) => (typeof options.latencyMs === 'number' ? options.latencyMs : options.latencyMs?.[service] ?? 0);

  function notify(entry) {
    if (typeof options.onRequest !== 'function') return;
    try { options.onRequest(entry); } catch { /* observers never break a response */ }
  }

  function write(res, entry, response) {
    entry.status = response.status;
    const headers = { ...(response.headers ?? {}) };
    if (response.contentType) headers['content-type'] = response.contentType;
    res.writeHead(response.status, headers);
    res.end(response.body ?? '');
    notify(entry);
  }

  function destroy(res, entry, mode) {
    entry.status = 0;
    entry.reset = true;
    notify(entry);
    if (mode === 'immediate') {
      res.socket?.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.write('{"partial":');
    setTimeout(() => res.socket?.destroy(), 10).unref?.();
  }

  async function handle(service, req, res) {
    const url = new URL(req.url, 'http://synthetic.local');
    const raw = await readBody(req);
    const contentType = req.headers['content-type'];
    const body = parseBody(raw, contentType);
    const entry = {
      seq: ++seq,
      service,
      method: req.method,
      path: url.pathname,
      query: queryObject(url.searchParams),
      status: null,
      bodySha256: raw.length ? sha256(raw) : null,
      body: redactForLog(body),
      remoteAddress: req.socket?.remoteAddress ?? null,
      ts: Date.now(),
    };
    requestLog.push(entry);
    const ctx = { req, url, method: req.method, path: url.pathname, body, raw };

    const lat = latencyFor(service);
    if (lat > 0) await sleep(lat);

    const fault = faults.find((f) => f.service === service && matcherHits(f.matcher, req.method, url.pathname, `${url.pathname}${url.search}`));
    if (fault) {
      entry.fault = fault.id;
      if (fault.times !== undefined) {
        fault.times -= 1;
        if (fault.times <= 0) faults.splice(faults.indexOf(fault), 1);
      }
      const f = fault.fault;
      if (f.delayMs) await sleep(f.delayMs);
      if (f.destroy) return destroy(res, entry, f.destroy);
      if (f.status) {
        const b = f.body === undefined ? { message: `synthetic fault ${f.status}` } : f.body;
        return write(res, entry, typeof b === 'string'
          ? text(f.status, b, f.contentType ?? 'text/plain; charset=utf-8')
          : json(f.status, b));
      }
    }

    const hs = handshake(service, ctx, env);
    if (hs) return write(res, entry, hs);

    const denied = authenticate(service, ctx, env);
    if (denied && !denied.public) {
      entry.unauthorized = true;
      return write(res, entry, denied);
    }

    let response;
    try {
      response = ROUTERS[service](ctx, env);
    } catch (err) {
      response = json(500, { message: `synthetic ${service} error: ${err?.message ?? err}` });
    }
    if (!response) {
      entry.unrouted = true;
      return write(res, entry, json(404, { message: `synthetic ${service}: no route for ${req.method} ${url.pathname}` }));
    }
    if (response.destroyAfterMs !== undefined) {
      await sleep(response.destroyAfterMs);
      return destroy(res, entry, 'immediate');
    }
    if (response.delayMs !== undefined) {
      await sleep(response.delayMs);
      if (res.destroyed || req.socket.destroyed) {
        entry.status = 0;
        entry.clientGone = true;
        notify(entry);
        return undefined;
      }
      return write(res, entry, response.then);
    }
    return write(res, entry, response);
  }

  const selected = options.only ?? SERVICE_NAMES;
  for (const s of selected) {
    if (!SERVICE_NAMES.includes(s)) throw new Error(`unknown service '${s}' (valid: ${SERVICE_NAMES.join(', ')})`);
  }
  const advertise = options.advertiseHost ?? (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host);
  const urlHost = advertise.includes(':') ? `[${advertise}]` : advertise;
  const servers = {};
  for (const service of selected) {
    const server = http.createServer((req, res) => {
      handle(service, req, res).catch((err) => {
        try {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ message: String(err?.message ?? err) }));
        } catch { /* socket already gone */ }
      });
    });
    server.keepAliveTimeout = 1000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(options.ports?.[service] ?? 0) || 0, host, resolve);
    });
    servers[service] = server;
    env.urls[service] = `http://${urlHost}:${server.address().port}`;
  }

  const urls = {
    JELLYFIN_URL: env.urls.jellyfin,
    SONARR_URL: env.urls.sonarr,
    RADARR_URL: env.urls.radarr,
    QBIT_URL: env.urls.qbittorrent,
    PROWLARR_URL: env.urls.prowlarr,
    PYLOAD_URL: env.urls.pyload,
    FLARESOLVERR_URL: env.urls.flaresolverr,
  };

  let closed = false;
  return {
    urls,
    keys,
    requestLog,
    state,
    /** Base URL by service name ("jellyfin", "sonarr", ...). */
    url: (service) => env.urls[service],
    /** Bound port by service name. */
    port: (service) => servers[service]?.address().port,
    /**
     * Non-GET requests (what could have changed upstream state).
     * @param {{ since?: number, service?: string, excludeAuth?: boolean }} [opts]
     *   since = a `seq` watermark (exclusive); excludeAuth drops qBittorrent/PyLoad login handshakes.
     */
    mutations(opts = {}) {
      return requestLog.filter((e) => e.method !== 'GET' && e.method !== 'HEAD'
        && (opts.since === undefined || e.seq > opts.since)
        && (opts.service === undefined || e.service === opts.service)
        && !(opts.excludeAuth && ((e.service === 'qbittorrent' && e.path === '/api/v2/auth/login') || (e.service === 'pyload' && e.path === '/login'))));
    },
    /** Requests nothing routed (coverage gaps: the server called an endpoint the fakes do not implement). */
    unrouted: () => requestLog.filter((e) => e.unrouted),
    /** Highest `seq` so far; pass it as `since` to scope later assertions. */
    watermark: () => seq,
    requests: (service) => requestLog.filter((e) => e.service === service),
    snapshot: () => clone(state),
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((x) => x !== fn));
    },
    setFault(service, matcher, fault) {
      if (!SERVICE_NAMES.includes(service)) throw new Error(`unknown service '${service}'`);
      if (!isPlainObject(fault)) throw new Error('fault must be an object');
      const id = `fault-${++faultSeq}`;
      faults.push({ id, service, matcher: compileMatcher(matcher), fault, times: fault.times });
      return id;
    },
    clearFaults(serviceOrId) {
      for (let i = faults.length - 1; i >= 0; i--) {
        if (serviceOrId === undefined || faults[i].service === serviceOrId || faults[i].id === serviceOrId) faults.splice(i, 1);
      }
    },
    activeFaults: () => faults.map((f) => ({ id: f.id, service: f.service, times: f.times })),
    async close() {
      if (closed) return;
      closed = true;
      for (const t of env.timers) clearTimeout(t);
      await Promise.all(Object.values(servers).map((s) => new Promise((resolve) => {
        s.closeAllConnections?.();
        s.close(() => resolve());
      })));
    },
  };
}
