import {
  Mail,
  Contact,
  Settings,
  ChevronRight,
  ChevronLeft,
  Puzzle,
  Wand2,
  Bot,
} from 'lucide-react';
import { useState } from 'react';

// Logo asset path (from public folder)
const sarvLogo = './sarv.png';

type AppSection = 'mail' | 'teams' | 'chat' | 'meet' | 'webinar' | 'drive' | 'calendar' | 'contacts' | 'extensions' | 'ai-settings' | 'agent' | 'settings';

interface AppSidebarProps {
  activeSection: AppSection;
  onSectionChange: (section: AppSection) => void;
}

const menuItems: { id: AppSection; icon: typeof Mail; label: string }[] = [
  { id: 'mail', icon: Mail, label: 'Mail' },
  { id: 'contacts', icon: Contact, label: 'Contacts' },
];

export function AppSidebar({ activeSection, onSectionChange }: AppSidebarProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div
      className={`relative flex flex-col flex-shrink-0 bg-muted/30 border-r border-border transition-all duration-200 ${
        isExpanded ? 'w-48 min-w-48' : 'w-14 min-w-14'
      }`}
    >
      {/* Sarv Logo. It must not move a pixel while the rail animates between
          w-14 and w-48, and two separate things conspire to shrink it when
          collapsed: the row's content box is only 31px there (56 − 1px border −
          px-3), one pixel narrower than the 32px logo. `shrink-0` stops flexbox
          from squeezing it, and `max-w-none` opts out of Tailwind preflight's
          `img { max-width: 100% }`, which would otherwise clamp it to that same
          31px. Without both, object-contain renders it 31×31 and drops it half a
          pixel — a visible twitch on every toggle. `px-3` keeps its left edge
          pinned at 12px in both states, so the extra pixel spills harmlessly
          into the row's right padding. */}
      <button
        onClick={() => window.electronAPI.app.openExternal('https://sarv.com/sarvinbox')}
        className="h-14 shrink-0 flex items-center justify-start px-3 border-b border-border hover:bg-accent/50 transition-colors cursor-pointer"
      >
        <img src={sarvLogo} alt="Sarv.com" className="h-8 w-8 max-w-none shrink-0 object-contain" />
      </button>

      {/* Menu Items */}
      <div className="flex-1 py-2">
        {menuItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeSection === item.id;

          return (
            <button
              key={item.id}
              onClick={() => {
                onSectionChange(item.id);
                // Clicking the Contacts icon always lands on the overview —
                // even if the user is already on /contacts with a contact
                // selected, this resets the detail pane. Contacts.tsx
                // listens for this event and clears selectedContact.
                if (item.id === 'contacts') {
                  document.dispatchEvent(new CustomEvent('sarvinbox:contacts-home'));
                }
              }}
              className={`w-full flex items-center gap-3 px-4 py-3 transition-colors relative ${
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
              title={!isExpanded ? item.label : undefined}
            >
              {/* Active indicator */}
              {isActive && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-primary rounded-r-full" />
              )}
              <Icon className="h-5 w-5 flex-shrink-0" />
              {isExpanded && (
                <span className="text-sm font-medium truncate">{item.label}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Extensions & Settings Buttons */}
      <div className="border-t border-border">
        <button
          onClick={() => onSectionChange('extensions')}
          className={`w-full flex items-center gap-3 px-4 py-3 transition-colors relative ${
            activeSection === 'extensions'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          }`}
          title={!isExpanded ? 'Extensions' : undefined}
        >
          {activeSection === 'extensions' && (
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-primary rounded-r-full" />
          )}
          <Puzzle className="h-5 w-5 flex-shrink-0" />
          {isExpanded && (
            <span className="text-sm font-medium truncate">Extensions</span>
          )}
        </button>
        <button
          onClick={() => onSectionChange('agent')}
          className={`w-full flex items-center gap-3 px-4 py-3 transition-colors relative ${
            activeSection === 'agent'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          }`}
          title={!isExpanded ? 'Email Agent' : undefined}
        >
          {activeSection === 'agent' && (
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-primary rounded-r-full" />
          )}
          <Bot className="h-5 w-5 flex-shrink-0" />
          {isExpanded && (
            <span className="text-sm font-medium truncate">Email Agent</span>
          )}
        </button>
        <button
          onClick={() => onSectionChange('ai-settings')}
          className={`w-full flex items-center gap-3 px-4 py-3 transition-colors relative ${
            activeSection === 'ai-settings'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          }`}
          title={!isExpanded ? 'AI Settings' : undefined}
        >
          {activeSection === 'ai-settings' && (
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-primary rounded-r-full" />
          )}
          <Wand2 className="h-5 w-5 flex-shrink-0" />
          {isExpanded && (
            <span className="text-sm font-medium truncate">AI Settings</span>
          )}
        </button>
        <button
          onClick={() => onSectionChange('settings')}
          className={`w-full flex items-center gap-3 px-4 py-3 transition-colors relative ${
            activeSection === 'settings'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          }`}
          title={!isExpanded ? 'Settings' : undefined}
        >
          {activeSection === 'settings' && (
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-primary rounded-r-full" />
          )}
          <Settings className="h-5 w-5 flex-shrink-0" />
          {isExpanded && (
            <span className="text-sm font-medium truncate">Settings</span>
          )}
        </button>

        {/* Expand/Collapse toggle — an in-rail row under Settings. It used to
            float as a semicircle over the right border, where it covered the
            mail sidebar's storage quota bar. */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full flex items-center gap-3 px-4 py-3 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          title={isExpanded ? 'Collapse' : 'Expand'}
          aria-label={isExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
          aria-expanded={isExpanded}
        >
          {isExpanded ? (
            <ChevronLeft className="h-5 w-5 flex-shrink-0" />
          ) : (
            <ChevronRight className="h-5 w-5 flex-shrink-0" />
          )}
          {isExpanded && (
            <span className="text-sm font-medium truncate">Collapse</span>
          )}
        </button>
      </div>
    </div>
  );
}

export type { AppSection };
