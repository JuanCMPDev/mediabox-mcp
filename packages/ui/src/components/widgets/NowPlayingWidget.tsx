import { useState } from 'react';
import { Tv2, MessageSquareWarning, XCircle, Info, Send, X, WifiOff } from 'lucide-react';
import styles from './NowPlayingWidget.module.css';
import { GlassCard }  from '@/components/atoms/GlassCard';
import { IconButton } from '@/components/atoms/IconButton';
import { Skeleton }   from '@/components/atoms/Skeleton';
import { GlassInput } from '@/components/atoms/GlassInput';
import { GlassButton }from '@/components/atoms/GlassButton';
import { useKillSession, useMessageUser } from '@/lib/mutations';
import { useToast } from '@/lib/toast';
import type { PlaybackSession } from '@mediabox/contracts';

type AdminMode = 'idle' | 'confirm-kill' | 'send-message' | 'show-info';

interface NowPlayingWidgetProps {
  session:   PlaybackSession | null;
  isLoading: boolean;
  error:     Error | null;
}

export function NowPlayingWidget({ session, isLoading, error }: NowPlayingWidgetProps) {
  return (
    <GlassCard className={styles.widget}>
      <div className={styles.header}>
        <div className={styles.headerTitle}><Tv2 size={14} />Jellyfin Active Stream</div>
      </div>

      {isLoading && !session && <SessionSkeleton />}

      {error && !session && (
        <div className={styles.empty}>
          <WifiOff size={36} color="var(--error)" />
          <p>Cannot reach Jellyfin</p>
        </div>
      )}

      {!isLoading && !error && !session && (
        <div className={styles.empty}>
          <Tv2 size={36} />
          <p>No active streams</p>
        </div>
      )}

      {session && <SessionView session={session} />}
    </GlassCard>
  );
}

function SessionView({ session }: { session: PlaybackSession }) {
  const [imgError, setImgError] = useState(false);
  const [mode, setMode]         = useState<AdminMode>('idle');
  const [msgHeader, setMsgHeader] = useState('');
  const [msgText,   setMsgText]   = useState('');

  const { toast } = useToast();
  const killSession   = useKillSession();
  const messageUser   = useMessageUser();

  const showImage = !!session.coverUrl && !imgError;

  function handleKillConfirm() {
    if (!session.jellyfinSessionId) return;
    killSession.mutate(session.jellyfinSessionId, {
      onSuccess: () => { toast(`Stream for ${session.userName} terminated`, 'success'); setMode('idle'); },
      onError:   (e) => { toast(`Kill failed: ${e.message}`, 'error'); setMode('idle'); },
    });
  }

  function handleSendMessage() {
    if (!session.jellyfinSessionId || !msgText.trim()) return;
    messageUser.mutate(
      { sessionId: session.jellyfinSessionId, header: msgHeader || 'Admin', text: msgText },
      {
        onSuccess: () => {
          toast(`Message sent to ${session.userName}`, 'success');
          setMode('idle'); setMsgHeader(''); setMsgText('');
        },
        onError: (e) => toast(`Send failed: ${e.message}`, 'error'),
      }
    );
  }

  return (
    <div className={styles.body}>
      <div className={styles.cover}>
        {showImage ? (
          <img
            className={styles.coverImage}
            src={session.coverUrl}
            alt={session.mediaTitle}
            onError={() => setImgError(true)}
          />
        ) : (
          <div
            className={styles.coverPlaceholder}
            style={{ background: session.coverGradient ?? 'var(--surface-container-highest)' }}
          >
            <Tv2 size={32} color="rgba(255,255,255,0.3)" />
          </div>
        )}
      </div>

      <div className={styles.info}>
        <div className={styles.nowTag}>
          <div className={styles.pulseDot} />
          {session.isPlaying ? 'Playing' : 'Paused'}
        </div>
        <div className={styles.title}>{session.mediaTitle}</div>
        <div className={styles.subtitle}>{session.mediaSubtitle}</div>
        <div className={styles.user}>
          Watching as{' '}
          <span style={{ color: 'var(--on-surface)' }}>{session.userName}</span>
          {session.deviceName && (
            <span style={{ color: 'var(--on-surface-muted)', fontSize: 11 }}> · {session.deviceName}</span>
          )}
        </div>

        <div className={styles.progressSection}>
          <div className={styles.progressTimes}>
            <span>{session.currentTime}</span>
            <span>{session.totalTime}</span>
          </div>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${session.progress}%` }} />
          </div>
        </div>

        {/* Admin area — switches between idle / confirm-kill / send-message / info */}
        <div className={styles.adminArea}>
          {mode === 'idle' && (
            <div className={styles.controls}>
              <IconButton title="Session Info" onClick={() => setMode('show-info')}>
                <Info size={16} />
              </IconButton>
              <IconButton title="Send Message to User" onClick={() => setMode('send-message')}>
                <MessageSquareWarning size={16} />
              </IconButton>
              <IconButton title="Kill Stream" onClick={() => setMode('confirm-kill')}>
                <XCircle size={16} color="var(--error)" />
              </IconButton>
            </div>
          )}

          {mode === 'show-info' && (
            <div className={styles.inlinePanel}>
              <div className={styles.inlineRow}>
                <span className={styles.infoKey}>Session ID</span>
                <span className={styles.infoVal}>{session.jellyfinSessionId?.slice(0, 16)}…</span>
              </div>
              <div className={styles.inlineRow}>
                <span className={styles.infoKey}>Device</span>
                <span className={styles.infoVal}>{session.deviceName ?? '—'}</span>
              </div>
              <button className={styles.dismissBtn} onClick={() => setMode('idle')}>
                <X size={13} /> Close
              </button>
            </div>
          )}

          {mode === 'confirm-kill' && (
            <div className={styles.inlinePanel}>
              <span className={styles.confirmText}>
                Terminate stream for <strong>{session.userName}</strong>?
              </span>
              <div className={styles.inlineBtns}>
                <GlassButton
                  variant="secondary" size="sm"
                  onClick={() => setMode('idle')}
                >Cancel</GlassButton>
                <GlassButton
                  variant="primary" size="sm"
                  onClick={handleKillConfirm}
                  disabled={killSession.isPending}
                >
                  {killSession.isPending ? 'Killing…' : 'Kill Stream'}
                </GlassButton>
              </div>
            </div>
          )}

          {mode === 'send-message' && (
            <div className={styles.inlinePanel}>
              <GlassInput
                value={msgHeader}
                onChange={setMsgHeader}
                placeholder="Header (optional)"
              />
              <GlassInput
                value={msgText}
                onChange={setMsgText}
                placeholder="Message text…"
                onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                autoFocus
              />
              <div className={styles.inlineBtns}>
                <GlassButton variant="secondary" size="sm" onClick={() => setMode('idle')}>
                  <X size={13} /> Cancel
                </GlassButton>
                <GlassButton
                  variant="primary" size="sm"
                  onClick={handleSendMessage}
                  disabled={!msgText.trim() || messageUser.isPending}
                >
                  <Send size={13} />
                  {messageUser.isPending ? 'Sending…' : 'Send'}
                </GlassButton>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SessionSkeleton() {
  return (
    <div className={styles.body}>
      <Skeleton variant="block" width={120} height={170} />
      <div className={styles.info} style={{ gap: 10 }}>
        <Skeleton variant="text-sm"   width="60%" />
        <Skeleton variant="text-xl"   width="80%" />
        <Skeleton variant="text-base" width="70%" />
        <Skeleton variant="text-sm"   width="50%" />
        <div style={{ marginTop: 'auto' }}>
          <Skeleton variant="block" height={3} />
        </div>
      </div>
    </div>
  );
}
