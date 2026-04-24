import { useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { DashboardView } from '@/views/DashboardView';
import { LibraryView } from '@/views/LibraryView';
import { ChatView } from '@/views/ChatView';
import { SettingsView } from '@/views/SettingsView';
import type { View } from '@/lib/types';

export default function App() {
  const [activeView, setActiveView] = useState<View>('dashboard');

  return (
    <AppShell
      activeView={activeView}
      onViewChange={setActiveView}
      serverOnline={true}
    >
      {activeView === 'dashboard' && <DashboardView />}
      {activeView === 'library'   && <LibraryView />}
      {activeView === 'chat'      && <ChatView />}
      {activeView === 'settings'  && <SettingsView />}
    </AppShell>
  );
}
