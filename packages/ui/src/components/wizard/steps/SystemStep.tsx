import { GlassInput } from '@/components/atoms/GlassInput';
import type { WizardDraft } from '@/lib/wizard-types';

interface Props {
  draft: WizardDraft;
  setSystem: (patch: Partial<WizardDraft['system']>) => void;
}

export function SystemStep({ draft, setSystem }: Props) {
  return (
    <>
      <div className="wizard-field">
        <label className="wizard-label">Timezone</label>
        <GlassInput
          value={draft.system.timezone}
          onChange={v => setSystem({ timezone: v })}
          placeholder="Europe/Madrid"
        />
        <span className="wizard-hint">
          IANA format (<code>Continent/City</code>). Auto-detected from your browser.
        </span>
      </div>

      <div className="wizard-row">
        <div className="wizard-field">
          <label className="wizard-label">PUID</label>
          <GlassInput
            value={String(draft.system.puid)}
            onChange={v => setSystem({ puid: parseInt(v, 10) || 0 })}
            placeholder="1000"
          />
          <span className="wizard-hint">User ID Docker writes files as.</span>
        </div>
        <div className="wizard-field">
          <label className="wizard-label">PGID</label>
          <GlassInput
            value={String(draft.system.pgid)}
            onChange={v => setSystem({ pgid: parseInt(v, 10) || 0 })}
            placeholder="1000"
          />
          <span className="wizard-hint">Group ID, usually the same as PUID.</span>
        </div>
      </div>

      <div className="wizard-field" style={{
        background: 'var(--glass-tint)',
        padding: 'var(--space-2)',
        borderRadius: 'var(--radius-md)',
      }}>
        <span className="wizard-hint">
          On Linux, run <code>id -u</code> and <code>id -g</code> in a terminal to find your IDs.
          On Windows/macOS the defaults <code>1000:1000</code> almost always work.
        </span>
      </div>
    </>
  );
}
