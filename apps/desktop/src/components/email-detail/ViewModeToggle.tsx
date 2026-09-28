import { List, MessageSquare, type LucideIcon } from 'lucide-react';

import { IconButton } from '../Tooltip';

/** The two ways to read a conversation, left to right as the toggle draws them. */
const VIEW_MODES: readonly { chat: boolean; name: string; Icon: LucideIcon }[] = [
  { chat: false, name: 'List view', Icon: List },
  { chat: true, name: 'Chat view', Icon: MessageSquare },
];

interface ViewModeToggleProps {
  /** Whether the chat view is the selected mode. */
  chatViewEnabled: boolean;
  onToggle: (chat: boolean) => void;
}

/**
 * The List / Chat switch on the thread's header line.
 *
 * Both buttons are icons alone, so each is an `IconButton` — the shared Tooltip
 * (a native `title` waits ~500ms) and an `aria-label` — with `aria-pressed`
 * saying which one is on. 'bare', because the selected segment's own
 * background is the state; a hover background on top of it would hide it.
 * Neither is ever disabled: the chat view always has something to show —
 * placeholders while it splits, the standard bubbles otherwise.
 */
export function ViewModeToggle({ chatViewEnabled, onToggle }: ViewModeToggleProps) {
  return (
    <div className="flex items-center gap-1 bg-muted rounded-md p-0.5">
      {VIEW_MODES.map(({ chat, name, Icon }) => {
        const selected = chat === chatViewEnabled;
        return (
          <IconButton
            key={name}
            size="sm"
            variant="bare"
            tooltip={name}
            pressed={selected}
            icon={<Icon className="h-4 w-4" />}
            onClick={() => onToggle(chat)}
            className={`rounded-md transition-colors ${selected
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
              }`}
          />
        );
      })}
    </div>
  );
}
