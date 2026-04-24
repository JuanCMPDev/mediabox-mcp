import { ExternalLink } from 'lucide-react';
import styles from './ServiceDock.module.css';
import type { ServiceEndpoint, ServiceId } from '@/lib/types';

interface Brand {
  iconUrl: string;
  bg: string;
}

/* Brand gradients + icon choice per service. Colors picked to echo each
 * project's own palette while staying legible over the dark glass. */
const BRANDS: Record<ServiceId, Brand> = {
  jellyfin:     { iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/jellyfin.png',           bg: 'linear-gradient(135deg, #4a1e5e, #9147c7)' },
  sonarr:       { iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/sonarr.png',         bg: 'linear-gradient(135deg, #033b60, #2ba0d9)' },
  radarr:       { iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/radarr.png',          bg: 'linear-gradient(135deg, #5a3500, #c08a17)' },
  prowlarr:     { iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/prowlarr.png',        bg: 'linear-gradient(135deg, #4a1c07, #c14c1b)' },
  qbittorrent:  { iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/qbittorrent.png',      bg: 'linear-gradient(135deg, #0a1a30, #26528e)' },
  pyload:       { iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/pyload.png', bg: 'linear-gradient(135deg, #18381a, #3f7030)' },
  flaresolverr: { iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/flaresolverr.png',        bg: 'linear-gradient(135deg, #4a2200, #c96818)' },
  bazarr:       { iconUrl: 'https://cdn.jsdelivr.net/gh/walkxcode/dashboard-icons/png/bazarr.png',     bg: 'linear-gradient(135deg, #3a1a00, #7a4a10)' },
};

interface ServiceDockProps {
  services: ServiceEndpoint[];
}

export function ServiceDock({ services }: ServiceDockProps) {
  function handleOpen(svc: ServiceEndpoint) {
    if (svc.status === 'offline') return;
    window.open(svc.url, '_blank', 'noopener,noreferrer');
  }

  return (
    <footer className={styles.dock}>
      <span className={styles.sectionLabel}>Services</span>

      {services.map((svc) => {
        const brand = BRANDS[svc.id];
        const isOffline = svc.status === 'offline';

        return (
          <button
            key={svc.id}
            type="button"
            className={[styles.item, isOffline && styles.offline].filter(Boolean).join(' ')}
            onClick={() => handleOpen(svc)}
            aria-label={`Open ${svc.name} (${svc.url})`}
            disabled={isOffline}
          >
            <div className={styles.icon} style={{ background: brand.bg }}>
              <img src={brand.iconUrl} alt={svc.name} style={{ width: 24, height: 24, objectFit: 'contain' }} />
              <span className={`${styles.statusDot} ${styles[svc.status]}`} />
            </div>

            <div className={styles.tooltip} role="tooltip">
              <span className={styles.tooltipName}>{svc.name}</span>
              <span className={styles.tooltipMeta}>
                <span>{svc.description}</span>
                <span>·</span>
                <span className={`${styles.tooltipStatus} ${styles[svc.status]}`}>
                  {svc.status}
                </span>
              </span>
              {!isOffline && (
                <span className={styles.tooltipHint}>
                  <ExternalLink size={10} />
                  {svc.url.replace(/^https?:\/\//, '')}
                </span>
              )}
            </div>
          </button>
        );
      })}
    </footer>
  );
}
