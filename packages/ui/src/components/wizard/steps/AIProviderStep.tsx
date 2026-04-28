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
        The AI assistant answers questions, shows status, and runs actions. Skip this step
        and configure it later from Settings if you want.
      </p>

      <div className="wizard-field">
        <label className="wizard-label">LLM provider</label>
        <SegmentedControl
          value={draft.ai.provider}
          onChange={v => setAI({ provider: v as WizardDraft['ai']['provider'] })}
          options={[
            { value: 'none',       label: 'No AI' },
            { value: 'openrouter', label: 'OpenRouter' },
            { value: 'google',     label: 'Google AI' },
          ]}
        />
        <span className="wizard-hint">
          {draft.ai.provider === 'none'       && 'Skip the AI assistant for now. Local Ollama support is coming in phase 4.'}
          {draft.ai.provider === 'openrouter' && 'One key, access to Claude, GPT-4, and more. Get one at openrouter.ai/keys.'}
          {draft.ai.provider === 'google'     && 'Gemini via Google AI Studio. Cheapest option for prototyping.'}
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
              <label className="wizard-label">Model</label>
              <GlassInput
                value={draft.ai.model}
                onChange={v => setAI({ model: v })}
                placeholder="anthropic/claude-3.5-sonnet"
              />
              <span className="wizard-hint">
                Other options: <code>openai/gpt-4o</code>, <code>google/gemini-2.0-flash-exp</code>.
              </span>
            </div>
          )}

          {draft.ai.provider === 'google' && (
            <div className="wizard-field">
              <label className="wizard-label">Model (optional)</label>
              <GlassInput
                value={draft.ai.model}
                onChange={v => setAI({ model: v })}
                placeholder="gemini-2.0-flash-exp"
              />
              <span className="wizard-hint">
                Leave blank to use the SDK default.
              </span>
            </div>
          )}
        </>
      )}
    </>
  );
}
