export type HealthStatus = 'ok' | 'warning' | 'critical';
export interface HealthMetric {
    label: string;
    value: number;
    unit: string;
    status: HealthStatus;
}
export interface ServerHealth {
    cpu: HealthMetric;
    ram: HealthMetric;
    disk: HealthMetric;
    uptime: string;
    serverName: string;
    version: string;
    online: boolean;
}
export type MediaType = 'movie' | 'episode' | 'music';
export interface PlaybackSession {
    id: string;
    userName: string;
    userId?: string;
    deviceName?: string;
    mediaTitle: string;
    mediaSubtitle: string;
    mediaType: MediaType;
    coverUrl?: string;
    coverGradient?: string;
    progress: number;
    currentTime: string;
    totalTime: string;
    isPlaying: boolean;
    jellyfinSessionId?: string;
}
export type DownloadStatus = 'downloading' | 'paused' | 'seeding' | 'completed' | 'error';
export type DownloadSource = 'qbittorrent' | 'pyload';
export interface Download {
    id: string;
    name: string;
    progress: number;
    size: string;
    speed: string;
    uploadSpeed?: string;
    eta: string;
    status: DownloadStatus;
    category?: string;
    source: DownloadSource;
}
export interface LibraryStats {
    movies: number;
    shows: number;
    episodes: number;
    music: number;
    totalSize: string;
}
export type ServiceStatus = 'online' | 'warning' | 'offline';
export type ServiceId = 'jellyfin' | 'sonarr' | 'radarr' | 'prowlarr' | 'qbittorrent' | 'pyload' | 'flaresolverr' | 'bazarr';
export interface ServiceEndpoint {
    id: ServiceId;
    name: string;
    description: string;
    url: string;
    status: ServiceStatus;
    version?: string;
}
