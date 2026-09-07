import { Keyboard, Check } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';

import { prettyKey } from '../../config/keyboard-shortcuts';
import { useEmailStore } from '../../store/email-store';

interface ShortcutTrainingStepProps {
  onNext: () => void;
}

interface TrainingShortcut {
  key: string;
  label: string;
  description: string;
}

const TRAINING_SHORTCUTS: TrainingShortcut[] = [
  { key: 'j', label: 'j', description: 'Navigate down' },
  { key: 'k', label: 'k', description: 'Navigate up' },
  { key: 'Enter', label: 'Enter', description: 'Open email' },
  { key: 'e', label: 'e', description: 'Archive' },
  { key: 'd', label: 'd', description: 'Delete' },
  { key: 's', label: 's', description: 'Star / Unstar' },
  { key: 'c', label: 'c', description: 'Compose new email' },
  { key: 'r', label: 'r', description: 'Reply' },
  { key: '/', label: '/', description: 'Search' },
];

export function ShortcutTrainingStep({ onNext }: ShortcutTrainingStepProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [completed, setCompleted] = useState<boolean[]>(new Array(TRAINING_SHORTCUTS.length).fill(false));
  const [justCompleted, setJustCompleted] = useState(false);

  // Sync progress from store
  const syncing = useEmailStore((s) => s.syncing);
  const syncStatus = useEmailStore((s) => s.syncStatus);

  const allDone = completed.every(Boolean);
  const current = TRAINING_SHORTCUTS[currentIndex];

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Ignore if all done
    if (allDone) return;

    // Check if pressed key matches current shortcut
    if (e.key === current.key) {
      e.preventDefault();
      e.stopPropagation();

      setCompleted((prev) => {
        const next = [...prev];
        next[currentIndex] = true;
        return next;
      });
      setJustCompleted(true);

      // Move to next after brief animation
      setTimeout(() => {
        setJustCompleted(false);
        if (currentIndex < TRAINING_SHORTCUTS.length - 1) {
          setCurrentIndex(currentIndex + 1);
        }
      }, 500);
    }
  }, [current, currentIndex, allDone]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);

  const handleFinish = () => {
    onNext();
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-primary/10 rounded-lg">
          <Keyboard className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h2 className="text-xl font-semibold">Keyboard Shortcuts</h2>
          <p className="text-sm text-muted-foreground">Press each key to learn the shortcuts</p>
        </div>
      </div>

      {/* Progress */}
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm text-muted-foreground">
          {completed.filter(Boolean).length} of {TRAINING_SHORTCUTS.length}
        </span>
        <div className="flex gap-1">
          {TRAINING_SHORTCUTS.map((_, i) => (
            <div
              key={i}
              className={`w-2 h-2 rounded-full transition-colors ${
                completed[i] ? 'bg-primary' : i === currentIndex ? 'bg-primary/40' : 'bg-border'
              }`}
            />
          ))}
        </div>
      </div>

      {/* Current shortcut to practice */}
      {!allDone ? (
        <div className={`p-6 rounded-lg border-2 text-center mb-4 transition-all ${
          justCompleted ? 'border-green-500 bg-green-500/10' : 'border-primary/30 bg-primary/5'
        }`}>
          {justCompleted ? (
            <div className="flex items-center justify-center gap-2 text-green-600">
              <Check className="h-6 w-6" />
              <span className="text-lg font-medium">Got it!</span>
            </div>
          ) : (
            <>
              <div className="text-muted-foreground text-sm mb-3">{current.description}</div>
              <div className="inline-flex items-center justify-center min-w-[3rem] h-12 px-4 bg-background border-2 border-border rounded-lg text-xl font-mono font-bold shadow-sm">
                {prettyKey(current.key)}
              </div>
              <div className="text-xs text-muted-foreground mt-3">Press the key above</div>
            </>
          )}
        </div>
      ) : (
        <div className="p-6 rounded-lg border-2 border-green-500 bg-green-500/10 text-center mb-4">
          <Check className="h-8 w-8 text-green-600 mx-auto mb-2" />
          <div className="text-lg font-medium text-green-600">All shortcuts learned!</div>
          <div className="text-sm text-muted-foreground mt-1">Press <kbd className="px-1.5 py-0.5 bg-background border rounded text-xs font-mono">?</kbd> anytime to see all shortcuts</div>
        </div>
      )}

      {/* Shortcut list */}
      <div className="space-y-1 mb-5 max-h-36 overflow-y-auto">
        {TRAINING_SHORTCUTS.map((shortcut, i) => (
          <div
            key={shortcut.key}
            className={`flex items-center gap-3 px-3 py-1.5 rounded text-sm transition-colors ${
              i === currentIndex && !allDone ? 'bg-primary/10' : ''
            }`}
          >
            <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${
              completed[i] ? 'bg-primary text-primary-foreground' : 'bg-muted'
            }`}>
              {completed[i] && <Check className="h-3 w-3" />}
            </div>
            <kbd className="px-1.5 py-0.5 bg-muted border border-border rounded text-xs font-mono min-w-[2rem] text-center">
              {prettyKey(shortcut.key)}
            </kbd>
            <span className={completed[i] ? 'text-muted-foreground' : ''}>{shortcut.description}</span>
          </div>
        ))}
      </div>

      {/* Sync progress indicator */}
      {syncing && syncStatus && (
        <div className="text-xs text-muted-foreground text-center mb-4">
          {syncStatus.state === 'idle' || syncStatus.state === 'realtime'
            ? 'Inbox ready!'
            : `Syncing emails... ${syncStatus.messagesProcessed}${syncStatus.messagesTotal ? `/${syncStatus.messagesTotal}` : ''}`
          }
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={handleFinish}
          className={`flex-1 px-4 py-2.5 rounded-md font-medium transition-colors ${
            allDone
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground'
          }`}
        >
          {allDone ? 'Go to Inbox' : 'Skip Training'}
        </button>
      </div>
    </div>
  );
}
