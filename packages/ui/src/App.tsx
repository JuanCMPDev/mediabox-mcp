import { useState } from 'react';
import { AppShell }      from '@/components/layout/AppShell';
import { DashboardView } from '@/views/DashboardView';
import { LibraryView }   from '@/views/LibraryView';
import { ChatView }      from '@/views/ChatView';
import { SettingsView }  from '@/views/SettingsView';
import { WizardView }    from '@/views/WizardView';
import { ToastProvider } from '@/lib/toast';
import { useAppState }   from '@/lib/use-app-state';
import type { View } from '@/lib/types';

export default function App() {
  const [activeView, setActiveView] = useState<View>('dashboard');
  const { state, loading, refresh } = useAppState();

  // While the app state is loading we render nothing — BootGate is already on
  // top and shows the loader. Once loaded, we either route to the wizard or
  // the dashboard.
  if (loading || !state) return null;

  const wizardComplete = state.wizardCompletedAt !== null;

  return (
    <ToastProvider>
      {!wizardComplete ? (
        <WizardView onComplete={() => void refresh()} />
      ) : (
        <AppShell activeView={activeView} onViewChange={setActiveView}>
          {activeView === 'dashboard' && <DashboardView />}
          {activeView === 'library'   && <LibraryView />}
          {activeView === 'chat'      && <ChatView />}
          {activeView === 'settings'  && <SettingsView />}
        </AppShell>
      )}
    </ToastProvider>
  );
}
