import { Trans, useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { GlassInput } from '@/components/atoms/GlassInput';
import { SegmentedControl } from '@/components/atoms/SegmentedControl';
import { api } from '@/lib/api';
import type { WizardDraft } from '@/lib/wizard-types';

interface Props {
  draft: WizardDraft;
  setAI: (patch: Partial<WizardDraft['ai']>) => void;
}

const GB = 1024 * 1024 * 1024;
const RUNTIME_PORTS: Record<string, number> = { ollama: 11434, lmstudio: 1234, llamacpp: 8080, vllm: 8000 };

export function AIProviderStep({ draft, setAI }: Props) {
  const { t } = useTranslation('wizard');
  const isLocal = draft.ai.provider === 'local';
  // Detection only runs when the owner actually picks local mode: probing hardware is
  // never on the critical path of the wizard (§3.3).
  const hardware = useQuery({
    queryKey: ['hardware-profile'],
    queryFn: () => api.hardwareProfile(),
    enabled: isLocal,
    retry: false,
    staleTime: 10 * 60 * 1000,
  });

  return (
    <>
      <p className="wizard-hint" style={{ margin: 0 }}>
        {t('ai.intro')}
      </p>

      <div className="wizard-field">
        <label className="wizard-label">{t('ai.providerLabel')}</label>
        <SegmentedControl
          value={draft.ai.provider}
          onChange={v => setAI({ provider: v as WizardDraft['ai']['provider'] })}
          options={[
            { value: 'none',       label: t('ai.providers.none') },
            { value: 'local',      label: t('ai.providers.local') },
            { value: 'openrouter', label: t('ai.providers.openrouter') },
            { value: 'google',     label: t('ai.providers.google') },
          ]}
        />
        <span className="wizard-hint">
          {draft.ai.provider === 'none'       && t('ai.hints.none')}
          {draft.ai.provider === 'local'      && t('ai.hints.local')}
          {draft.ai.provider === 'openrouter' && t('ai.hints.openrouter')}
          {draft.ai.provider === 'google'     && t('ai.hints.google')}
        </span>
      </div>

      {draft.ai.provider === 'local' && (
        <>
          <div className="wizard-field">
            <label className="wizard-label">{t('ai.localRuntimeLabel')}</label>
            <SegmentedControl
              value={draft.ai.runtime || 'ollama'}
              onChange={v => setAI({ runtime: v })}
              options={[
                { value: 'ollama',   label: 'Ollama' },
                { value: 'lmstudio', label: 'LM Studio' },
                { value: 'llamacpp', label: 'llama.cpp' },
                { value: 'vllm',     label: 'vLLM' },
              ]}
            />
          </div>

          <div className="wizard-field">
            <label className="wizard-label">{t('ai.localBaseUrlLabel')}</label>
            <GlassInput
              value={draft.ai.baseUrl || (draft.ai.runtime === 'lmstudio' ? 'http://127.0.0.1:1234' : draft.ai.runtime === 'llamacpp' ? 'http://127.0.0.1:8080' : 'http://127.0.0.1:11434')}
              onChange={v => setAI({ baseUrl: v })}
              placeholder="http://127.0.0.1:11434"
            />
          </div>

          <div className="wizard-field">
            <label className="wizard-label">{t('ai.modelLabel')}</label>
            <GlassInput
              value={draft.ai.model || 'qwen2.5:7b'}
              onChange={v => setAI({ model: v })}
              placeholder="qwen2.5:7b"
            />
            <span className="wizard-hint">
              <Trans i18nKey="ai.hints.localModel" t={t}>
                Recommended: <code>qwen2.5:7b</code> (8K context) or <code>qwen2.5:3b</code>.
              </Trans>
            </span>
          </div>

          <LocalHardwareSummary
            data={hardware.data}
            loading={hardware.isLoading}
            failed={Boolean(hardware.error)}
            runtime={draft.ai.runtime || 'ollama'}
            onPickModel={(model, endpoint) => setAI({ model, ...(endpoint ? { baseUrl: endpoint } : {}) })}
            t={t}
          />

          <div className="wizard-field">
            <label className="wizard-label">{t('ai.localContextLabel')}</label>
            <GlassInput
              value={draft.ai.contextTokens ? String(draft.ai.contextTokens) : '8192'}
              onChange={v => setAI({ contextTokens: Number(v.replace(/[^0-9]/g, '')) || undefined })}
              placeholder="8192"
            />
            <span className="wizard-hint">{t('ai.localHint')}</span>
          </div>
        </>
      )}

      {(draft.ai.provider === 'openrouter' || draft.ai.provider === 'google') && (
        <>
          <div className="wizard-field">
            <label className="wizard-label">{t('ai.apiKeyLabel')}</label>
            <GlassInput
              value={draft.ai.apiKey}
              onChange={v => setAI({ apiKey: v })}
              placeholder={draft.ai.provider === 'openrouter' ? 'sk-or-v1-…' : 'AIza…'}
            />
          </div>

          {draft.ai.provider === 'openrouter' && (
            <div className="wizard-field">
              <label className="wizard-label">{t('ai.modelLabel')}</label>
              <GlassInput
                value={draft.ai.model}
                onChange={v => setAI({ model: v })}
                placeholder="openai/gpt-4o"
              />
              <span className="wizard-hint">
                <Trans i18nKey="ai.hints.openrouterModel" t={t}>
                  Recommended: <code>openai/gpt-4o</code> or <code>google/gemini-2.5-flash</code>.
                </Trans>
              </span>
            </div>
          )}

          {draft.ai.provider === 'google' && (
            <div className="wizard-field">
              <label className="wizard-label">{t('ai.googleModelLabel')}</label>
              <GlassInput
                value={draft.ai.model}
                onChange={v => setAI({ model: v })}
                placeholder="gemini-2.5-flash"
              />
              <span className="wizard-hint">
                <Trans i18nKey="ai.hints.googleModel" t={t}>
                  Recommended: <code>gemini-2.5-flash</code>. Leave blank to use the SDK default.
                </Trans>
              </span>
            </div>
          )}
        </>
      )}
    </>
  );
}
/**
 * What the host actually has, and which catalog models fit it (§3.3 / §3.4 / LOC-09).
 * A model that does not fit is listed as such and never offered as a suggestion.
 */
function LocalHardwareSummary({
  data,
  loading,
  failed,
  runtime,
  onPickModel,
  t,
}: {
  data?: import('@mediabox/contracts').HardwareReport;
  loading: boolean;
  failed: boolean;
  runtime: string;
  onPickModel: (model: string, endpoint?: string) => void;
  t: ReturnType<typeof useTranslation<'wizard'>>['t'];
}) {
  if (loading) {
    return <span className="wizard-hint">{t('ai.detecting', 'Detecting hardware and local runtimes…')}</span>;
  }
  if (failed || !data) {
    return (
      <span className="wizard-hint">
        {t('ai.detectionFailed', 'Hardware could not be detected; configure the runtime by hand.')}
      </span>
    );
  }

  const { profile } = data;
  const gpu = profile.gpus[0];
  const detected = profile.detectedRuntimes.find(r => r.kind === runtime) ?? profile.detectedRuntimes[0];
  const fitting = data.models.filter(m => m.status !== 'exceeds_memory');
  const tooBig = data.models.filter(m => m.status === 'exceeds_memory');

  return (
    <div className="wizard-field">
      <label className="wizard-label">{t('ai.detected', 'Detected hardware')}</label>
      <span className="wizard-hint">
        {profile.os}/{profile.arch} · {(profile.ramBytes / GB).toFixed(0)} GB RAM ·{' '}
        {gpu
          ? `${gpu.name}${gpu.vramBytes ? ` (${(gpu.vramBytes / GB).toFixed(0)} GB VRAM)` : ''} · ${profile.recommendedBackend}`
          : t('ai.noGpu', 'no GPU detected, CPU inference')}
      </span>
      <span className="wizard-hint">
        {detected
          ? t('ai.runtimeFound', 'Runtime found:') + ` ${detected.kind} ${detected.version ?? ''} (${detected.baseUrl})`
          : t('ai.runtimeMissing', 'No local runtime is answering: install Ollama or LM Studio, then start it.')}
      </span>

      {fitting.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {fitting.map(model => {
            const name = model.runtimeModelName[runtime] ?? model.id;
            const endpoint = detected?.baseUrl ?? `http://127.0.0.1:${RUNTIME_PORTS[runtime] ?? 11434}`;
            return (
              <button
                key={model.id}
                type="button"
                className="wizard-chip"
                onClick={() => onPickModel(name, endpoint)}
                title={model.reason ?? ''}
              >
                {name} · {model.tier}
                {model.status === 'recommended' ? ' ★' : ''}
              </button>
            );
          })}
        </div>
      )}

      {tooBig.length > 0 && (
        <span className="wizard-hint">
          {t('ai.notRecommended', 'Does not fit this hardware:')} {tooBig.map(m => m.id).join(', ')}
        </span>
      )}
      {data.models.some(m => m.licenseNote) && (
        <span className="wizard-hint">
          {data.models.find(m => m.licenseNote)!.licenseNote}
        </span>
      )}
      {profile.probeErrors.length > 0 && (
        <span className="wizard-hint">{profile.probeErrors[0]}</span>
      )}
    </div>
  );
}
