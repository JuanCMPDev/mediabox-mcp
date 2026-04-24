import styles from './DashboardView.module.css';
import { NowPlayingWidget } from '@/components/widgets/NowPlayingWidget';
import { ServerHealthWidget } from '@/components/widgets/ServerHealthWidget';
import { DownloadQueueWidget } from '@/components/widgets/DownloadQueueWidget';
import { LibrarySummaryWidget } from '@/components/widgets/LibrarySummaryWidget';
import {
  MOCK_NOW_PLAYING,
  MOCK_HEALTH,
  MOCK_DOWNLOADS,
  MOCK_LIBRARY,
} from '@/mocks/data';

export function DashboardView() {
  return (
    <div className={styles.view}>
      <div className={styles.nowPlaying}>
        <NowPlayingWidget session={MOCK_NOW_PLAYING} />
      </div>
      <div className={styles.serverHealth}>
        <ServerHealthWidget health={MOCK_HEALTH} />
      </div>
      <div className={styles.downloadQueue}>
        <DownloadQueueWidget downloads={MOCK_DOWNLOADS} />
      </div>
      <div className={styles.librarySummary}>
        <LibrarySummaryWidget stats={MOCK_LIBRARY} />
      </div>
    </div>
  );
}
