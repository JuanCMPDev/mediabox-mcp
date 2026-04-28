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
import { ProwlarrSetupStep } from '@/components/wizard/steps/ProwlarrSetupStep';
import { useWizardDraft } from '@/lib/use-wizard-draft';
import { useDeployStream } from '@/lib/use-deploy-stream';
import { draftToDeployConfig } from '@/lib/wizard-types';
import { defaultStackDir, setAppState, restartSidecar, type WorkdirProbe } from '@/lib/tauri-bridge';
import { reloadRuntimeConfig } from '@/lib/runtime-config';

const STEP_TITLES = [
  'Pre-flight',
  'Deployment',
  'System',
  'Media paths',
  'Services',
  'AI assistant',
  'Telegram bot',
  'Review',
];

const STEP_SUBTITLES = [
  'Make sure Docker is ready before we start.',
  'How should the stack be exposed, and where do the orchestration files live?',
  'A few host parameters Docker needs to know.',
  'Folders where Sonarr and Radarr will keep your organized media.',
  'Credentials for each service’s web UI.',
  'Optional: enable the in-app AI chat and pick an LLM provider.',
  'Optional: connect a Telegram bot to use the AI from your phone.',
  'Last chance to review before kicking off the deploy.',
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
  // Set after deploy succeeds and the sidecar has been restarted with the
  // freshly-written .env. Triggers the "Configurar Prowlarr" post-deploy step.
  const [postDeployReady, setPostDeployReady]   = useState(false);

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
        // PyLoad credentials are not collected — its image hardcodes
        // pyload:pyload and we don't try to rotate them. The wizard step
        // only exposes Jellyfin + qBittorrent inputs.
        const s = draft.services;
        return s.jellyfinAdminUsername.length > 0
          && s.jellyfinAdminPassword.length >= 8
          && s.qbitPassword.length >= 8;
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

  // Phase 1 of post-deploy: write a partial state.json (just stackDir so the
  // sidecar can find the newly-written .env) and restart the sidecar so the
  // ProwlarrSetupStep's polling endpoint has PROWLARR_API_KEY in its env.
  // wizardCompletedAt stays null — App.tsx still routes us to the wizard until
  // the user finishes the post-deploy step.
  const beginPostDeploy = async () => {
    await setAppState({
      wizardCompletedAt: null,
      stackDir:          draft.workDir,
      configSummary:     null,
    });
    await restartSidecar();
    await reloadRuntimeConfig();
    setPostDeployReady(true);
  };

  // Phase 2 of post-deploy: write the full state and exit the wizard. Called
  // either when the user completes the ProwlarrSetupStep (≥1 indexer) or when
  // they explicitly skip it.
  const finishWizard = async () => {
    await setAppState({
      wizardCompletedAt: new Date().toISOString(),
      stackDir:          draft.workDir,
      configSummary: {
        deploymentMode:    draft.deployment.mode,
        imageTag:          draft.deployment.imageTag,
        baseDomain:        draft.deployment.baseDomain.trim() || null,
        timezone:          draft.system.timezone,
        puid:              draft.system.puid,
        pgid:              draft.system.pgid,
        paths:             draft.paths,
        jellyfinAdminUser: draft.services.jellyfinAdminUsername,
        pyloadUser:        'pyload',
        bazarrEnabled:     draft.services.bazarrEnabled,
        aiProvider:        draft.ai.provider,
        aiModel:           draft.ai.model.trim() || null,
        telegramEnabled:   draft.telegram.enabled,
        telegramUserCount: draft.telegram.allowedUserIds
          .split(',').map(s => s.trim()).filter(Boolean).length,
      },
    });
    // No need to restart the sidecar again — beginPostDeploy already did that.
    clear();
    onComplete();
  };

  if (postDeployReady) {
    return (
      <StepShell
        stepIndex={TOTAL_STEPS - 1}
        totalSteps={TOTAL_STEPS}
        title="Set up Prowlarr"
        subtitle="Add at least one indexer so the stack can search for content."
        hideNav
      >
        <ProwlarrSetupStep
          onContinue={() => void finishWizard()}
          onSkip={() => void finishWizard()}
        />
      </StepShell>
    );
  }

  if (deploying) {
    return (
      <StepShell
        stepIndex={TOTAL_STEPS - 1}
        totalSteps={TOTAL_STEPS}
        title="Deploying"
        subtitle="This can take a few minutes the first time."
        hideNav
      >
        <DeployProgress
          state={deployState}
          onCancel={() => { cancel(); setDeploying(false); }}
          onFinish={() => void beginPostDeploy()}
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
      forwardLabel={draft.step === TOTAL_STEPS - 1 ? 'Start deploy' : undefined}
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
