import { useEffect, useState, useCallback } from 'react';
import { type WizardDraft, emptyDraft, DRAFT_STORAGE_KEY } from './wizard-types';

/**
 * Persistent wizard draft. Reads/writes localStorage so a reload mid-wizard
 * does not lose the user's progress. Draft is cleared with `clear()` once
 * the deploy succeeds.
 */
export function useWizardDraft() {
  const [draft, setDraft] = useState<WizardDraft>(() => {
    try {
      const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (!raw) return emptyDraft();
      const parsed = JSON.parse(raw) as Partial<WizardDraft>;
      // Merge with empty so any fields added in newer versions get defaults.
      const base = emptyDraft();
      return { ...base, ...parsed,
        deployment: { ...base.deployment, ...(parsed.deployment ?? {}) },
        system:     { ...base.system,     ...(parsed.system ?? {}) },
        paths:      { ...base.paths,      ...(parsed.paths ?? {}) },
        services:   { ...base.services,   ...(parsed.services ?? {}) },
        ai:         { ...base.ai,         ...(parsed.ai ?? {}) },
        telegram:   { ...base.telegram,   ...(parsed.telegram ?? {}) },
      };
    } catch {
      return emptyDraft();
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } catch {
      // Quota exceeded or private mode — silently ignore.
    }
  }, [draft]);

  const update = useCallback(<K extends keyof WizardDraft>(key: K, value: WizardDraft[K]) => {
    setDraft(d => ({ ...d, [key]: value }));
  }, []);

  const updateNested = useCallback(<K extends keyof WizardDraft>(
    section: K,
    patch: Partial<WizardDraft[K]>,
  ) => {
    setDraft(d => ({ ...d, [section]: { ...(d[section] as object), ...patch } }));
  }, []);

  const setStep = useCallback((step: number) => {
    setDraft(d => ({ ...d, step }));
  }, []);

  const clear = useCallback(() => {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
    setDraft(emptyDraft());
  }, []);

  return { draft, setDraft, update, updateNested, setStep, clear };
}
