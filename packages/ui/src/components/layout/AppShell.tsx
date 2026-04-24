import styles from './AppShell.module.css';
import { AtmosphericBackground } from './AtmosphericBackground';
import { TopBar }      from './TopBar';
import { Sidebar }     from './Sidebar';
import { ServiceDock } from './ServiceDock';
import { useHealth, useServices } from '@/lib/queries';
import { MOCK_SERVICES } from '@/mocks/data';
import type { View } from '@/lib/types';

interface AppShellProps {
  children:     React.ReactNode;
  activeView:   View;
  onViewChange: (view: View) => void;
}

export function AppShell({ children, activeView, onViewChange }: AppShellProps) {
  const { data: health }   = useHealth();
  const { data: services } = useServices();

  const serverOnline = health?.online ?? false;
  // Fall back to mock services while backend is loading / offline
  const serviceList  = services ?? MOCK_SERVICES;

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
      <ServiceDock services={serviceList} />
    </div>
  );
}
