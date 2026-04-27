import { useEffect, useState } from 'react';
import { StepShell } from '@/components/wizard/StepShell';
import { DeployProgress } from '@/components/wizard/DeployProgress';
import { PreflightStep } from '@/components/wizard/steps/PreflightStep';
import { DeploymentStep } from '@/components/wizard/steps/DeploymentStep';
import { SystemStep } from '@/components/wizard/steps/SystemStep';
import { PathsStep } from '@/components/wizard/steps/PathsStep';
import { ServicesStep } from '@/components/wizard/steps/ServicesStep';
import { AIProviderStep } from '@/components/wizard/steps/AIProviderStep';
import { TelegramStep } from '@/components/wizard/steps/TelegramStep';
import { ReviewStep } from '@/components/wizard/steps/ReviewStep';
import { useWizardDraft } from '@/lib/use-wizard-draft';
import { useDeployStream } from '@/lib/use-deploy-stream';
import { draftToDeployConfig } from '@/lib/wizard-types';
import { defaultStackDir, setAppState, restartSidecar, type WorkdirProbe } from '@/lib/tauri-bridge';
import { reloadRuntimeConfig } from '@/lib/runtime-config';

const STEP_TITLES = [
  'Pre-flight',
  'Despliegue',
  'Sistema',
  'Rutas de medios',
  'Servicios',
  'Asistente AI',
  'Telegram bot',
  'Revisión y deploy',
];

const STEP_SUBTITLES = [
  'Verificamos que Docker esté listo en tu máquina antes de empezar.',
  '¿Cómo querés exponer el stack? ¿Dónde guardamos los archivos de orquestación?',
  'Algunos parámetros del host que Docker necesita saber.',
  'Carpetas donde Sonarr y Radarr van a guardar las descargas organizadas.',
  'Credenciales para acceder a cada servicio por web.',
  'Activá el chat AI nativo y conectá un proveedor de LLM.',
  'Opcionalmente, enchufá un bot de Telegram para usar el AI desde el celular.',
  'Última oportunidad para revisar antes de tirar el deploy.',
];

const TOTAL_STEPS = STEP_TITLES.length;

interface Props {
  onComplete: () => void;
}

export function WizardView({ onComplete }: Props) {
  const { draft, setStep, update, updateNested, clear } = useWizardDraft();
  const { state: deployState, start, cancel, reset } = useDeployStream();

  const [preflightReady, setPreflightReady]     = useState(false);
  const [deploying, setDeploying]               = useState(false);
  const [workdirProbe, setWorkdirProbe]         = useState<WorkdirProbe | null>(null);

  // Pre-fill workDir on first mount with the OS-suggested default.
  useEffect(() => {
    if (!draft.workDir) {
      void defaultStackDir().then(d => update('workDir', d));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goBack    = () => setStep(Math.max(0, draft.step - 1));
  const goForward = () => setStep(Math.min(TOTAL_STEPS - 1, draft.step + 1));

  const canGoForward = (): boolean => {
    switch (draft.step) {
      case 0: return preflightReady;
      case 1: {
        const d = draft.deployment;
        if (!draft.workDir.trim()) return false;
        if (!d.imageTag.trim()) return false;
        if (d.mode === 'vps'    && (!d.baseDomain.trim() || !d.letsEncryptEmail.trim())) return false;
        if (d.mode === 'tunnel' && (!d.baseDomain.trim() || !d.tunnelToken.trim()))      return false;
        // Block if the probe ran and the filesystem is incompatible.
        // null means "hasn't run yet" — we don't block on that.
        if (workdirProbe !== null && !workdirProbe.sqliteCompatible) return false;
        return true;
      }
      case 2: return draft.system.timezone.trim().length > 0;
      case 3: return Object.values(draft.paths).every(p => p.trim().length > 0);
      case 4: {
        const s = draft.services;
        return s.jellyfinAdminUsername.length > 0
          && s.jellyfinAdminPassword.length >= 8
          && s.qbitPassword.length >= 8
          && s.pyloadUsername.length > 0
          && s.pyloadPassword.length >= 8;
      }
      case 5: {
        if (draft.ai.provider === 'none') return true;
        if (!draft.ai.apiKey.trim()) return false;
        if (draft.ai.provider === 'openrouter' && !draft.ai.model.trim()) return false;
        return true;
      }
      case 6: {
        if (!draft.telegram.enabled) return true;
        if (draft.ai.provider === 'none') return false;
        return draft.telegram.botToken.trim().length > 0;
      }
      case 7: return true;
      default: return false;
    }
  };

  const launchDeploy = async () => {
    setDeploying(true);
    const config = draftToDeployConfig(draft);
    await start(config, draft.workDir, false);
  };

  const finishWizard = async () => {
    // Order matters: write state.json first so the restarted sidecar reads
    // the newly-deployed stack's .env on its first probe.
    await setAppState({
      wizardCompletedAt: new Date().toISOString(),
      stackDir: draft.workDir,
      configSummary: {
        deploymentMode:    draft.deployment.mode,
        imageTag:          draft.deployment.imageTag,
        baseDomain:        draft.deployment.baseDomain.trim() || null,
        timezone:          draft.system.timezone,
        puid:              draft.system.puid,
        pgid:              draft.system.pgid,
        paths:             draft.paths,
        jellyfinAdminUser: draft.services.jellyfinAdminUsername,
        pyloadUser:        draft.services.pyloadUsername,
        bazarrEnabled:     draft.services.bazarrEnabled,
        aiProvider:        draft.ai.provider,
        aiModel:           draft.ai.model.trim() || null,
        telegramEnabled:   draft.telegram.enabled,
        telegramUserCount: draft.telegram.allowedUserIds
          .split(',').map(s => s.trim()).filter(Boolean).length,
      },
    });
    await restartSidecar();
    // Wait until the new sidecar reports `ready`, refresh our cached
    // { apiUrl, token } so the dashboard's first fetch hits the new instance.
    await reloadRuntimeConfig();
    clear();
    onComplete();
  };

  if (deploying) {
    return (
      <StepShell
        stepIndex={TOTAL_STEPS - 1}
        totalSteps={TOTAL_STEPS}
        title="Desplegando el stack"
        subtitle="Esto puede tardar varios minutos en el primer arranque."
        hideNav
      >
        <DeployProgress
          state={deployState}
          onCancel={() => { cancel(); setDeploying(false); }}
          onFinish={() => void finishWizard()}
          onRetry={() => { reset(); void launchDeploy(); }}
        />
      </StepShell>
    );
  }

  return (
    <StepShell
      stepIndex={draft.step}
      totalSteps={TOTAL_STEPS}
      title={STEP_TITLES[draft.step]!}
      subtitle={STEP_SUBTITLES[draft.step]}
      onBack={goBack}
      onForward={draft.step === TOTAL_STEPS - 1 ? launchDeploy : goForward}
      canGoBack={draft.step > 0}
      canGoForward={canGoForward()}
      forwardLabel={draft.step === TOTAL_STEPS - 1 ? 'Iniciar deploy' : undefined}
    >
      {draft.step === 0 && <PreflightStep onReady={setPreflightReady} />}
      {draft.step === 1 && (
        <DeploymentStep
          draft={draft}
          setWorkDir={v => update('workDir', v)}
          setDeployment={p => updateNested('deployment', p)}
          onProbeResult={setWorkdirProbe}
        />
      )}
      {draft.step === 2 && <SystemStep   draft={draft} setSystem={p => updateNested('system', p)} />}
      {draft.step === 3 && <PathsStep    draft={draft} setPaths={p => updateNested('paths', p)} />}
      {draft.step === 4 && <ServicesStep draft={draft} setServices={p => updateNested('services', p)} />}
      {draft.step === 5 && <AIProviderStep draft={draft} setAI={p => updateNested('ai', p)} />}
      {draft.step === 6 && <TelegramStep draft={draft} setTelegram={p => updateNested('telegram', p)} />}
      {draft.step === 7 && <ReviewStep draft={draft} />}
    </StepShell>
  );
}
