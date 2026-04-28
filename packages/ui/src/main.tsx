import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import '@fontsource/plus-jakarta-sans/400.css';
import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';

import './styles/reset.css';
import './styles/theme.css';
import './styles/globals.css';

// Initialise i18next before any component renders so useTranslation() never
// races with the bundle load (PR 3.4d).
import '@/lib/i18n';

import App from './App';
import { BootGate } from '@/components/layout/BootGate';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      refetchOnWindowFocus: true,
      // Global retry config — individual queries can override
      retry: 2,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BootGate>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </BootGate>
  </React.StrictMode>
);
