import { useEffect, useState } from 'react';
import { AppShell }      from '@/components/layout/AppShell';
import { DashboardView } from '@/views/DashboardView';
import { LibraryView }   from '@/views/LibraryView';
import { ChatView }      from '@/views/ChatView';
import { SettingsView }  from '@/views/SettingsView';
import { WizardView }    from '@/views/WizardView';
import { ToastProvider } from '@/lib/toast';
import { useAppState }   from '@/lib/use-app-state';
import { useSetupInfo }  from '@/lib/queries';
import { AppPreferencesProvider } from '@/lib/use-app-preferences';
import { useLanguageSync } from '@/lib/i18n';
import { useLibraryAutoRefresh } from '@/lib/use-library-auto-refresh';
import type { View } from '@/lib/types';

export default function App() {
  const { state, loading, refresh } = useAppState();

  if (loading || !state) return null;

  // Wrap the tree with the preferences provider so refresh-interval changes
  // and locale switches propagate live without an app reload.
  return (
    <AppPreferencesProvider initial={state.appPreferences ?? null}>
      <AppRouter
        wizardComplete={state.wizardCompletedAt != null}
        onComplete={() => void refresh()}
      />
    </AppPreferencesProvider>
  );
}

interface AppRouterProps {
  wizardComplete: boolean;
  onComplete:     () => void;
}

function AppRouter({ wizardComplete, onComplete }: AppRouterProps) {
  const [activeView, setActiveView] = useState<View>('dashboard');
  const { data: info } = useSetupInfo();
  const aiEnabled = info ? info.ai.provider !== 'none' : true;
  // Mirror the active locale from preferences into i18next.
  useLanguageSync();
  // Scheduled Jellyfin library refresh; no-op when the user keeps the
  // preference at 0 (default).
  useLibraryAutoRefresh();

  // If the user disables the AI provider in Settings while sitting on the
  // chat view, kick them back to the dashboard so they don't end up looking
  // at a now-orphaned screen.
  useEffect(() => {
    if (wizardComplete && !aiEnabled && activeView === 'chat') {
      setActiveView('dashboard');
    }
  }, [wizardComplete, aiEnabled, activeView]);

  return (
    <ToastProvider>
      {!wizardComplete ? (
        <WizardView onComplete={onComplete} />
      ) : (
        <AppShell activeView={activeView} onViewChange={setActiveView}>
          {activeView === 'dashboard' && <DashboardView />}
          {activeView === 'library'   && <LibraryView />}
          {activeView === 'chat' && aiEnabled && <ChatView />}
          {activeView === 'settings'  && <SettingsView />}
        </AppShell>
      )}
    </ToastProvider>
  );
}
