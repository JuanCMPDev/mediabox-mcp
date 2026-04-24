import styles from './DashboardView.module.css';
import { NowPlayingWidget }    from '@/components/widgets/NowPlayingWidget';
import { ServerHealthWidget }  from '@/components/widgets/ServerHealthWidget';
import { DownloadQueueWidget } from '@/components/widgets/DownloadQueueWidget';
import { LibrarySummaryWidget} from '@/components/widgets/LibrarySummaryWidget';
import { useHealth, useSessions, useDownloads, useLibrary } from '@/lib/queries';

export function DashboardView() {
  const health    = useHealth();
  const sessions  = useSessions();
  const downloads = useDownloads();
  const library   = useLibrary();

  return (
    <div className={styles.view}>
      <div className={styles.nowPlaying}>
        <NowPlayingWidget
          session={sessions.data?.[0] ?? null}
          isLoading={sessions.isLoading}
          error={sessions.error}
        />
      </div>
      <div className={styles.serverHealth}>
        <ServerHealthWidget
          health={health.data ?? null}
          isLoading={health.isLoading}
          error={health.error}
        />
      </div>
      <div className={styles.downloadQueue}>
        <DownloadQueueWidget
          downloads={downloads.data ?? []}
          isLoading={downloads.isLoading}
          error={downloads.error}
        />
      </div>
      <div className={styles.librarySummary}>
        <LibrarySummaryWidget
          stats={library.data ?? null}
          isLoading={library.isLoading}
          error={library.error}
        />
      </div>
    </div>
  );
}
