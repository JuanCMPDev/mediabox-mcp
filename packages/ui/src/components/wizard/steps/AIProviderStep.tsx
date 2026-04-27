import { GlassInput } from '@/components/atoms/GlassInput';
import { SegmentedControl } from '@/components/atoms/SegmentedControl';
import type { WizardDraft } from '@/lib/wizard-types';

interface Props {
  draft: WizardDraft;
  setAI: (patch: Partial<WizardDraft['ai']>) => void;
}

export function AIProviderStep({ draft, setAI }: Props) {
  return (
    <>
      <p className="wizard-hint" style={{ margin: 0 }}>
        El asistente AI de Mediabox usa un LLM para responder preguntas, mostrar el estado y
        ejecutar acciones. Podés saltar este paso y configurarlo después.
      </p>

      <div className="wizard-field">
        <label className="wizard-label">Proveedor de LLM</label>
        <SegmentedControl
          value={draft.ai.provider}
          onChange={v => setAI({ provider: v as WizardDraft['ai']['provider'] })}
          options={[
            { value: 'none',       label: 'Sin AI' },
            { value: 'openrouter', label: 'OpenRouter' },
            { value: 'google',     label: 'Google AI' },
          ]}
        />
        <span className="wizard-hint">
          {draft.ai.provider === 'none'       && 'Sin asistente AI por ahora. La fase 4 agregará soporte para Ollama (local).'}
          {draft.ai.provider === 'openrouter' && 'Provee acceso a Claude, GPT-4 y demás. Generá la key en openrouter.ai/keys.'}
          {draft.ai.provider === 'google'     && 'Gemini de Google AI Studio. Es el provider más económico para prototipar.'}
        </span>
      </div>

      {draft.ai.provider !== 'none' && (
        <>
          <div className="wizard-field">
            <label className="wizard-label">API key</label>
            <GlassInput
              value={draft.ai.apiKey}
              onChange={v => setAI({ apiKey: v })}
              placeholder={draft.ai.provider === 'openrouter' ? 'sk-or-v1-…' : 'AIza…'}
            />
          </div>

          {draft.ai.provider === 'openrouter' && (
            <div className="wizard-field">
              <label className="wizard-label">Modelo</label>
              <GlassInput
                value={draft.ai.model}
                onChange={v => setAI({ model: v })}
                placeholder="anthropic/claude-3.5-sonnet"
              />
              <span className="wizard-hint">
                Otros: <code>openai/gpt-4o</code>, <code>google/gemini-2.0-flash-exp</code>.
              </span>
            </div>
          )}

          {draft.ai.provider === 'google' && (
            <div className="wizard-field">
              <label className="wizard-label">Modelo (opcional)</label>
              <GlassInput
                value={draft.ai.model}
                onChange={v => setAI({ model: v })}
                placeholder="gemini-2.0-flash-exp"
              />
              <span className="wizard-hint">
                Si lo dejás vacío, usamos el default del SDK.
              </span>
            </div>
          )}
        </>
      )}
    </>
  );
}
