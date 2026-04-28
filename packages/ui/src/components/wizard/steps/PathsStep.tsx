import { Folder } from 'lucide-react';
import { GlassInput } from '@/components/atoms/GlassInput';
import { GlassButton } from '@/components/atoms/GlassButton';
import type { WizardDraft } from '@/lib/wizard-types';
import { pickDirectory } from '@/lib/tauri-bridge';

interface Props {
  draft: WizardDraft;
  setPaths: (patch: Partial<WizardDraft['paths']>) => void;
}

export function PathsStep({ draft, setPaths }: Props) {
  const browseField = async (key: keyof WizardDraft['paths']) => {
    const picked = await pickDirectory(draft.paths[key] || draft.workDir);
    if (picked) setPaths({ [key]: picked });
  };

  return (
    <>
      <p className="wizard-hint" style={{ margin: 0 }}>
        Absolute paths recommended on Linux; relative paths resolve against the stack folder.
        Folders are created on first deploy if they don&apos;t exist.
      </p>

      <PathRow label="Movies" value={draft.paths.movies} onChange={v => setPaths({ movies: v })} onBrowse={() => browseField('movies')} />
      <PathRow label="TV"     value={draft.paths.tv}     onChange={v => setPaths({ tv: v })}     onBrowse={() => browseField('tv')} />
      <PathRow label="Anime"  value={draft.paths.anime}  onChange={v => setPaths({ anime: v })}  onBrowse={() => browseField('anime')} />
      <PathRow label="Music"  value={draft.paths.music}  onChange={v => setPaths({ music: v })}  onBrowse={() => browseField('music')} />
    </>
  );
}

function PathRow({ label, value, onChange, onBrowse }: {
  label:    string;
  value:    string;
  onChange: (v: string) => void;
  onBrowse: () => void;
}) {
  return (
    <div className="wizard-field">
      <label className="wizard-label">{label}</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <GlassInput value={value} onChange={onChange} placeholder="./media/…" />
        </div>
        <GlassButton variant="secondary" size="md" onClick={onBrowse}>
          <Folder size={14} />
        </GlassButton>
      </div>
    </div>
  );
}
