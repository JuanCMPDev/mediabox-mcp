import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { ToastStack } from '@/components/atoms/Toast';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastItem {
  id:      string;
  type:    ToastType;
  message: string;
}

interface ToastCtx {
  toast: (message: string, type?: ToastType) => void;
}

const Ctx = createContext<ToastCtx>({ toast: () => {} });

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const toast = useCallback((message: string, type: ToastType = 'info') => {
    const id = `t${++counter.current}`;
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3500);
  }, []);

  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <ToastStack toasts={toasts} />
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
