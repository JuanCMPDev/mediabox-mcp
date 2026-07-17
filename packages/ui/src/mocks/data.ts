/* ─── Mock data — used when VITE_API_URL is not set or backend is offline ────
 * Shapes must stay 1-to-1 with @mediabox/contracts.
 * ──────────────────────────────────────────────────────────────────────── */
import type {
  Download,
  ServerHealth,
  PlaybackSession,
  LibraryStats,
  ServiceEndpoint,
} from '@mediabox/contracts';
import type { ChatMessage } from '@/lib/types';

export const MOCK_DOWNLOADS: Download[] = [
  {
    id: 'qbit:a1b2c3',
    name: 'The.Matrix.Resurrections.2021.2160p.UHD.BluRay.x265-TERMINAL',
    progress: 45, size: '58.2 GB', speed: '12.4 MB/s', eta: '43m',
    status: 'downloading', category: 'movies', source: 'qbittorrent',
  },
  {
    id: 'qbit:d4e5f6',
    name: 'Severance.S02E08.The.Grim.Barbarity.of.Optics.and.Design.1080p',
    progress: 92, size: '3.8 GB', speed: '8.1 MB/s', eta: '38s',
    status: 'downloading', category: 'tv', source: 'qbittorrent',
  },
  {
    id: 'qbit:g7h8i9',
    name: 'Dune.Part.Two.2024.2160p.IMAX.BluRay.x265.HDR10',
    progress: 100, size: '71.4 GB', speed: '—', uploadSpeed: '2.1 MB/s', eta: '—',
    status: 'seeding', category: 'movies', source: 'qbittorrent',
  },
  {
    id: 'qbit:j0k1l2',
    name: 'Blue.Eye.Samurai.S01.Complete.1080p.Netflix.WEB-DL',
    progress: 0, size: '22.1 GB', speed: '—', eta: '—',
    status: 'paused', category: 'anime', source: 'qbittorrent',
  },
  {
    id: 'pyload:42',
    name: 'Shogun.2024.S01.Complete.2160p.Hulu.WEB-DL.x265',
    progress: 38, size: '47.6 GB', speed: '5.3 MB/s', eta: '1h 33m',
    status: 'downloading', source: 'pyload',
  },
];

export const MOCK_HEALTH: ServerHealth = {
  cpu:  { label: 'CPU',  value: 34, unit: '%', status: 'ok' },
  ram:  { label: 'RAM',  value: 71, unit: '%', status: 'warning' },
  disk: { label: 'Disk', value: 58, unit: '%', status: 'ok' },
  uptime: '14d 6h 42m',
  serverName: 'Mediabox',
  version: '2.2.0-beta.2',
  online: true,
};

export const MOCK_NOW_PLAYING: PlaybackSession = {
  id: 'session-1',
  userName: 'Juan',
  userId: 'user-1',
  deviceName: 'Chrome on Windows',
  mediaTitle: 'Severance',
  mediaSubtitle: 'S02E07 — Chikhai Bardo',
  mediaType: 'episode',
  coverGradient: 'linear-gradient(135deg, #1a1a4e 0%, #2d1b69 40%, #0d3b6e 100%)',
  progress: 45,
  currentTime: '22:14',
  totalTime: '49:33',
  isPlaying: true,
  jellyfinSessionId: 'session-1',
};

export const MOCK_LIBRARY: LibraryStats = {
  movies: 847, shows: 124, episodes: 8391, music: 2140, totalSize: '42.7 TB',
};

export const MOCK_SERVICES: ServiceEndpoint[] = [
  { id: 'jellyfin',    name: 'Jellyfin',    description: 'Media server',      url: 'http://localhost:8096', status: 'online' },
  { id: 'sonarr',      name: 'Sonarr',      description: 'TV & anime',        url: 'http://localhost:8989', status: 'online' },
  { id: 'radarr',      name: 'Radarr',      description: 'Movie management',  url: 'http://localhost:7878', status: 'online' },
  { id: 'prowlarr',    name: 'Prowlarr',    description: 'Indexer manager',   url: 'http://localhost:9696', status: 'online' },
  { id: 'qbittorrent', name: 'qBittorrent', description: 'Torrent client',    url: 'http://localhost:8085', status: 'online' },
  { id: 'pyload',      name: 'PyLoad',      description: 'Direct downloader', url: 'http://localhost:8001', status: 'warning' },
  { id: 'flaresolverr',name: 'FlareSolverr',description: 'Cloudflare bypass', url: 'http://localhost:8191', status: 'offline' },
];

export const MOCK_CHAT_MESSAGES: ChatMessage[] = [
  { id: '1', role: 'assistant', content: 'Bienvenido a **Mediabox OS**. Soy tu asistente MCP. Puedo gestionar tu biblioteca, buscar contenido y controlar las descargas. ¿En qué te puedo ayudar?', timestamp: new Date(Date.now() - 120_000) },
  { id: '2', role: 'user', content: '¿Cuánto espacio libre queda en el servidor?', timestamp: new Date(Date.now() - 60_000) },
  { id: '3', role: 'assistant', content: 'El disco principal tiene **42%** de espacio libre (~28.4 TB disponibles de 47.8 TB). El directorio `/data/movies` es el más grande con 31.2 TB.', timestamp: new Date(Date.now() - 55_000) },
];

export const MOCK_ASSISTANT_RESPONSES: string[] = [
  'Entendido. Buscando en Radarr y Sonarr...',
  'Encontré varias coincidencias. ¿Quieres que te muestre los detalles o lo añado directamente a la cola?',
  'Hecho. El torrent se ha añadido a qBittorrent con categoría `movies`. Recibirás una notificación cuando complete la descarga.',
  'El servidor está respondiendo con normalidad. Tiempo de actividad: 14 días.',
  'Revisando la cola de descargas... hay 3 torrents activos y 1 en pausa.',
];
