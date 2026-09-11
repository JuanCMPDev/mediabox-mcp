import styles from './AppShell.module.css';
import { AtmosphericBackground } from './AtmosphericBackground';
import { TopBar }      from './TopBar';
import { Sidebar }     from './Sidebar';
import { ServiceDock } from './ServiceDock';
import { OperationsBadge, OperationsGate } from '@/components/operations/OperationsGate';
import { useHealth, useServices, useSetupInfo } from '@/lib/queries';
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
  const { data: info }     = useSetupInfo();

  const serverOnline = health?.online ?? false;
  // Fall back to mock services while backend is loading / offline
  const serviceList  = services ?? MOCK_SERVICES;
  // Hide the chat tab when no LLM provider is configured. While info is
  // still loading we default to *enabled* so the tab doesn't flicker on
  // every refresh; the App-level redirect catches a stale 'chat' selection.
  const aiEnabled    = info ? info.ai.provider !== 'none' : true;

  // OperationsGate owns the owner-approval modal for operation plans and
  // feeds the top-bar badge. It wraps the whole shell so any view (the
  // Settings operations list, for one) can reopen a plan via its context.
  return (
    <OperationsGate>
      <div className={styles.shell}>
        <AtmosphericBackground />
        <TopBar activeView={activeView} serverOnline={serverOnline} actions={<OperationsBadge />} />
        <Sidebar
          activeView={activeView}
          onViewChange={onViewChange}
          serverOnline={serverOnline}
          aiEnabled={aiEnabled}
        />
        <main className={styles.main}>{children}</main>
        <ServiceDock services={serviceList} />
      </div>
    </OperationsGate>
  );
}
