import { useTranslation } from 'react-i18next';
import type { WizardDraft } from '@/lib/wizard-types';
import styles from './ReviewStep.module.css';

interface Props {
  draft: WizardDraft;
}

export function ReviewStep({ draft }: Props) {
  const { t } = useTranslation('wizard');

  return (
    <>
      <p className="wizard-hint" style={{ margin: 0 }}>
        {t('review.intro')}
      </p>

      <div className={styles.summary}>
        <Section title={t('review.sections.deployment')}>
          <Row k={t('review.keys.mode')}        v={draft.deployment.mode} />
          <Row k={t('review.keys.stackAt')}    v={draft.workDir} mono />
          <Row k={t('review.keys.imageTag')}   v={draft.deployment.imageTag} />
          {draft.deployment.mode !== 'local' && (
            <Row k={t('review.keys.domain')} v={draft.deployment.baseDomain} />
          )}
        </Section>

        <Section title={t('review.sections.system')}>
          <Row k={t('review.keys.timezone')} v={draft.system.timezone} />
          <Row k={t('review.keys.uidGid')}  v={`${draft.system.puid}:${draft.system.pgid}`} />
        </Section>

        <Section title={t('review.sections.mediaPaths')}>
          <Row k={t('paths.movies')} v={draft.paths.movies} mono />
          <Row k={t('paths.tv')}     v={draft.paths.tv}     mono />
          <Row k={t('paths.anime')}  v={draft.paths.anime}  mono />
          <Row k={t('paths.music')}  v={draft.paths.music}  mono />
        </Section>

        <Section title={t('review.sections.services')}>
          <Row k={t('review.keys.jellyfinAdmin')} v={draft.services.jellyfinAdminUsername} />
          <Row k={t('review.keys.qbit')}    v={draft.services.qbitPassword.length > 0 ? t('review.values.qbitSet') : t('review.values.noPassword')} />
          <Row k={t('review.keys.pyload')}         v={t('review.values.pyloadDefault')} />
          <Row k={t('review.keys.bazarr')}         v={draft.services.bazarrEnabled ? t('review.values.enabled') : t('review.values.disabled')} />
        </Section>

        <Section title={t('review.sections.ai')}>
          <Row k={t('review.keys.provider')} v={draft.ai.provider === 'none' ? t('review.values.none') : draft.ai.provider} />
          {draft.ai.provider !== 'none' && (
            <Row k={t('review.keys.apiKey')} v={draft.ai.apiKey ? t('review.values.obscured', { last4: draft.ai.apiKey.slice(-4) }) : t('review.values.missing')} mono />
          )}
        </Section>

        <Section title={t('review.sections.telegram')}>
          <Row k={t('review.keys.status')} v={draft.telegram.enabled ? t('review.values.enabled') : t('review.values.disabled')} />
          {draft.telegram.enabled && (
            <>
              <Row k={t('review.keys.token')} v={draft.telegram.botToken ? t('review.values.obscured', { last4: draft.telegram.botToken.slice(-4) }) : t('review.values.missing')} mono />
              <Row k={t('review.keys.users')} v={draft.telegram.allowedUserIds || t('review.values.anyone')} />
            </>
          )}
        </Section>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={styles.section}>
      <h4 className={styles.sectionTitle}>{title}</h4>
      <dl className={styles.dl}>{children}</dl>
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <dt className={styles.dt}>{k}</dt>
      <dd className={[styles.dd, mono && styles.mono].filter(Boolean).join(' ')}>{v}</dd>
    </>
  );
}