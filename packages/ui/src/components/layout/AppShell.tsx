import styles from './AppShell.module.css';
import { AtmosphericBackground } from './AtmosphericBackground';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { ServiceDock } from './ServiceDock';
import { MOCK_SERVICES } from '@/mocks/data';
import type { View } from '@/lib/types';

interface AppShellProps {
  children: React.ReactNode;
  activeView: View;
  onViewChange: (view: View) => void;
  serverOnline: boolean;
}

export function AppShell({
  children,
  activeView,
  onViewChange,
  serverOnline,
}: AppShellProps) {
  return (
    <div className={styles.shell}>
      <AtmosphericBackground />
      <TopBar activeView={activeView} serverOnline={serverOnline} />
      <Sidebar
        activeView={activeView}
        onViewChange={onViewChange}
        serverOnline={serverOnline}
      />
      <main className={styles.main}>{children}</main>
      <ServiceDock services={MOCK_SERVICES} />
    </div>
  );
}
