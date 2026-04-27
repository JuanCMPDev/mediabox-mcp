import { GlassInput } from '@/components/atoms/GlassInput';
import { SegmentedControl } from '@/components/atoms/SegmentedControl';
import type { WizardDraft } from '@/lib/wizard-types';

interface Props {
  draft: WizardDraft;
  setTelegram: (patch: Partial<WizardDraft['telegram']>) => void;
}

export function TelegramStep({ draft, setTelegram }: Props) {
  const aiConfigured = draft.ai.provider !== 'none' && draft.ai.apiKey.trim().length > 0;

  return (
    <>
      <p className="wizard-hint" style={{ margin: 0 }}>
        El bot de Telegram replica al chat AI nativo, pero accesible desde tu teléfono.
        Para activarlo necesitás un bot creado con <code>@BotFather</code> y el provider AI ya configurado.
      </p>

      <div className="wizard-field">
        <label className="wizard-label">Activar Telegram bot</label>
        <SegmentedControl
          value={draft.telegram.enabled ? 'on' : 'off'}
          onChange={v => setTelegram({ enabled: v === 'on' })}
          options={[
            { value: 'off', label: 'No, gracias' },
            { value: 'on',  label: 'Sí, activar' },
          ]}
        />
      </div>

      {draft.telegram.enabled && !aiConfigured && (
        <div style={{
          padding: 'var(--space-2)',
          background: 'rgba(255, 180, 171, 0.08)',
          border: '1px solid rgba(255, 180, 171, 0.20)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--error)',
          font: '13px var(--font-sans)',
        }}>
          Volvé al paso anterior y configurá un proveedor AI primero — el bot lo necesita para responder.
        </div>
      )}

      {draft.telegram.enabled && aiConfigured && (
        <>
          <div className="wizard-field">
            <label className="wizard-label">Token del bot</label>
            <GlassInput
              value={draft.telegram.botToken}
              onChange={v => setTelegram({ botToken: v })}
              placeholder="123456:ABC-DEF…"
            />
            <span className="wizard-hint">
              Lo obtenés al hablar con <code>@BotFather</code> en Telegram y crear un bot nuevo con <code>/newbot</code>.
            </span>
          </div>

          <div className="wizard-field">
            <label className="wizard-label">User IDs autorizados</label>
            <GlassInput
              value={draft.telegram.allowedUserIds}
              onChange={v => setTelegram({ allowedUserIds: v })}
              placeholder="123456789, 987654321"
            />
            <span className="wizard-hint">
              Separados por comas. Vacío = cualquiera puede chatear con el bot.
              Para saber tu User ID, hablá con <code>@userinfobot</code>.
            </span>
          </div>
        </>
      )}
    </>
  );
}
