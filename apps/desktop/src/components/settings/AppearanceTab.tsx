import { Archive, Check, Minus, Monitor, Moon, Paperclip, Plus, Reply, RotateCcw, Star, Sun, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  ACCENTS,
  BUTTON_LABEL_CHOICES,
  DENSITIES,
  FONTS,
  MOTION_CHOICES,
  READING_FONTS,
  READING_SIZE_DEFAULT,
  READING_SIZE_MAX,
  READING_SIZE_MIN,
  READING_SIZE_STEP,
  SNIPPET_CHOICES,
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  appearanceCssVars,
  findReadingFont,
  resetAppearance,
  setAppearance,
  stepReadingSize,
  stepZoom,
  useAppearance,
  useResolvedTheme,
  type AppearanceChoice,
  type ThemeMode,
  type ZoomCommand,
} from '../../appearance';
import { toolbarButtonClass } from '../email-detail/toolbar-button-view';
import { Tooltip } from '../Tooltip';

const THEME_MODES: AppearanceChoice<ThemeMode>[] = [
  { id: 'light', label: 'Light', hint: 'Always light, whatever the OS is set to.' },
  { id: 'dark', label: 'Dark', hint: 'Always dark, whatever the OS is set to.' },
  { id: 'system', label: 'System', hint: 'Follows your OS, and switches with it.' },
];

const THEME_ICONS: Record<ThemeMode, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };

/** The two-column row the rest of the Settings screen uses. */
function Row({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <div className="grid grid-cols-[26rem_auto] items-center justify-between gap-6 py-3">
      <div>
        <div className="font-medium">{title}</div>
        <div className="text-sm text-muted-foreground">{description}</div>
      </div>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-b border-border pb-6">
      <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wider">{title}</h3>
      {children}
    </div>
  );
}

/**
 * A row of labelled cards, one of which is chosen — theme, density, snippet
 * lines, motion, button labels. One component so every group on this screen
 * behaves and reads the same, and a new setting is a list of choices rather
 * than another twenty lines of the same markup.
 */
function ChoiceCards<Id extends string | number>({
  label,
  choices,
  value,
  onChange,
  icons,
}: {
  label: string;
  choices: readonly AppearanceChoice<Id>[];
  value: Id;
  onChange: (id: Id) => void;
  icons?: Record<string, typeof Sun>;
}) {
  return (
    <div className="flex flex-wrap gap-3" role="radiogroup" aria-label={label}>
      {choices.map((choice) => {
        const active = value === choice.id;
        const Icon = icons?.[String(choice.id)];
        return (
          <button
            key={String(choice.id)}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(choice.id)}
            className={`flex-1 min-w-[10rem] text-left px-4 py-3 rounded-lg border-2 transition-colors ${
              active ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/40'
            }`}
          >
            <div className="flex items-center gap-2 font-medium">
              {Icon && <Icon className="h-4 w-4" />}
              {choice.label}
              {active && <Check className="h-4 w-4 ml-auto text-primary" />}
            </div>
            <div className="text-sm text-muted-foreground mt-1">{choice.hint}</div>
          </button>
        );
      })}
    </div>
  );
}

/** The on/off switch this screen uses, in one place rather than three. */
function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative w-11 h-6 rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-muted'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

/**
 * −/slider/+ with a percentage readout and a Reset that appears only off the
 * default. Shared by interface zoom and message text size: the two scales
 * differ, the control does not.
 */
function PercentStepper({
  label,
  value,
  min,
  max,
  step,
  fallback,
  onStep,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fallback: number;
  onStep: (value: number, command: ZoomCommand) => number;
  onChange: (next: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <Tooltip content="Smaller" delayMs={40}>
        <button
          type="button"
          aria-label={`Decrease ${label.toLowerCase()}`}
          disabled={value <= min}
          onClick={() => onChange(onStep(value, 'out'))}
          className="p-1.5 rounded border border-border hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Minus className="h-4 w-4" />
        </button>
      </Tooltip>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-48 accent-primary"
      />
      <Tooltip content="Larger" delayMs={40}>
        <button
          type="button"
          aria-label={`Increase ${label.toLowerCase()}`}
          disabled={value >= max}
          onClick={() => onChange(onStep(value, 'in'))}
          className="p-1.5 rounded border border-border hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus className="h-4 w-4" />
        </button>
      </Tooltip>
      <span className="w-12 text-sm tabular-nums text-right">{value}%</span>
      {value !== fallback && (
        <button type="button" onClick={() => onChange(fallback)} className="text-sm text-primary hover:underline">
          Reset
        </button>
      )}
    </div>
  );
}

const PREVIEW_SNIPPET =
  'Thanks — I have access now. I will run the migration tonight and send the numbers over in the morning so you have them before the call.';

/**
 * A miniature of the message list and the open message, styled by the SAME
 * custom properties and helpers the real ones read.
 *
 * It exists because the Settings screen covers what it is changing: without it,
 * picking a density means saving, navigating back to the inbox, looking, and
 * navigating in again. Everything here is built from the real `.list-row` /
 * `.list-snippet` / `.brand-fill` classes and the real `toolbarButtonClass`,
 * rather than a hand-drawn imitation, so it cannot drift away from what the app
 * actually does.
 */
function AppearancePreview() {
  const { snippetLines, buttonLabels } = useAppearance();
  const messages = [
    { sender: 'Devendra Kumar', subject: 'Production Server Details', time: 'Sep 3', unread: true, starred: true },
    { sender: 'Product Hunt Daily', subject: 'Ship fast and break things', time: '8:39 AM', unread: false, starred: false },
  ];
  const toolbar = [
    { name: 'Reply', Icon: Reply },
    { name: 'Archive', Icon: Archive },
    { name: 'Delete', Icon: Trash2 },
  ];
  return (
    <div className="rounded-lg border border-border overflow-hidden bg-background" aria-hidden="true">
      <div className="flex items-center gap-3 px-3 py-2 border-b border-border">
        <span className="brand-fill text-primary-foreground rounded-full px-3 py-1.5 text-sm font-medium inline-flex items-center gap-1.5">
          <Plus className="h-4 w-4" />
          Compose
        </span>
        <span className="text-sm text-muted-foreground">Live preview</span>
      </div>
      {messages.map((message) => (
        <div key={message.sender} className="list-row border-b border-border last:border-b-0 flex items-center gap-2">
          <Star className={`h-4 w-4 flex-shrink-0 ${message.starred ? 'fill-yellow-400 text-yellow-400' : 'text-muted-foreground'}`} />
          <span className={`w-24 flex-shrink-0 truncate text-sm ${message.unread ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
            {message.sender}
          </span>
          <span className={`flex-1 min-w-0 text-sm ${message.unread ? 'font-semibold text-foreground' : 'text-foreground'}`}>
            <span className="truncate block">{message.subject}</span>
            {/* Mirrors the list: at "None" the row renders no preview at all. */}
            {snippetLines > 0 && (
              <span className="list-snippet text-muted-foreground font-normal">{PREVIEW_SNIPPET}</span>
            )}
          </span>
          <Paperclip className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0">{message.time}</span>
        </div>
      ))}

      {/* The open message: its toolbar in the chosen label mode, and a body in
          the chosen reading font and size. */}
      <div className="border-t border-border flex flex-wrap items-center gap-1 px-2 py-1.5">
        {toolbar.map(({ name, Icon }) => (
          <span key={name} className={toolbarButtonClass(buttonLabels)}>
            {buttonLabels !== 'text' && <Icon className="h-4 w-4" />}
            {buttonLabels !== 'icons' && <span>{name}</span>}
          </span>
        ))}
      </div>
      <div
        className="px-3 py-3 border-t border-border text-foreground"
        style={{ fontFamily: 'var(--reading-font)', fontSize: 'var(--reading-size)' }}
      >
        Hi — here is how a message body reads at this size and in this face.
      </div>
    </div>
  );
}

/**
 * Appearance — theme, accent, text size, density, font, list and layout.
 *
 * Unlike every other Settings tab this one does NOT go through `updateSetting`
 * and the "Save Changes" button: appearance applies and persists the moment it
 * is changed. See appearance-store.ts for why (live preview, plus the View
 * menu's Cmd +/- writing zoom from outside this screen).
 */
export function AppearanceTab() {
  const appearance = useAppearance();
  const resolved = useResolvedTheme();
  const cssVars = appearanceCssVars(appearance, resolved);

  return (
    // Controls left, preview right on a wide window; stacked on a narrow one.
    // The preview is sticky so it stays on screen while the controls scroll —
    // it is the thing being changed, and scrolling away from it is what made
    // the old bottom-of-page placement useless.
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="space-y-6 min-w-0">
        <Section title="Theme">
          <ChoiceCards
            label="Theme"
            choices={THEME_MODES}
            icons={THEME_ICONS}
            value={appearance.theme}
            onChange={(theme) => setAppearance({ theme })}
          />
          {appearance.theme === 'system' && (
            <div className="text-sm text-muted-foreground mt-3">
              Your OS is currently asking for <span className="font-medium text-foreground">{resolved}</span>.
            </div>
          )}

          <Row
            title="Dark email bodies"
            description={
              resolved === 'dark'
                ? 'Re-colour the message itself for dark mode. Off, messages show on the white page their sender wrote them for.'
                : 'Re-colour the message itself for dark mode. Takes effect when the theme is dark.'
            }
          >
            <Switch
              label="Dark email bodies"
              checked={appearance.darkenEmails}
              onChange={(darkenEmails) => setAppearance({ darkenEmails })}
            />
          </Row>
          {appearance.darkenEmails && (
            <div className="text-sm text-muted-foreground">
              Senders style their mail for a white page, so this is a best effort on their
              markup: a message that already has a dark design is left alone, and images keep
              their own colours.
            </div>
          )}
        </Section>

        <Section title="Accent Colour">
          <Row title="Accent" description="Used for the Compose button, links, selection and focus rings.">
            <div className="flex items-center gap-2" role="radiogroup" aria-label="Accent colour">
              {ACCENTS.map((accent) => {
                const active = appearance.accent === accent.id;
                const tokens = resolved === 'dark' ? accent.dark : accent.light;
                return (
                  <Tooltip key={accent.id} content={accent.label} delayMs={40}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={active}
                      aria-label={accent.label}
                      onClick={() => setAppearance({ accent: accent.id })}
                      style={{
                        background: appearance.gradientAccents
                          ? `linear-gradient(135deg, hsl(${tokens.primary}) 0%, hsl(${tokens.gradientTo}) 100%)`
                          : `hsl(${tokens.primary})`,
                      }}
                      className={`h-8 w-8 rounded-full flex items-center justify-center transition-transform hover:scale-110 ${
                        active ? 'ring-2 ring-offset-2 ring-offset-background ring-foreground/60' : ''
                      }`}
                    >
                      {active && <Check className="h-4 w-4" style={{ color: `hsl(${tokens.foreground})` }} />}
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          </Row>

          <Row title="Gradient accents" description="Paint the primary action with a gradient instead of a flat fill.">
            <Switch
              label="Gradient accents"
              checked={appearance.gradientAccents}
              onChange={(gradientAccents) => setAppearance({ gradientAccents })}
            />
          </Row>
        </Section>

        <Section title="Text Size">
          <Row
            title="Interface zoom"
            description="Scales the whole app, exactly like Cmd/Ctrl + and −  — which now change this setting, so the size survives a restart."
          >
            <PercentStepper
              label="Interface zoom"
              value={appearance.zoom}
              min={ZOOM_MIN}
              max={ZOOM_MAX}
              step={ZOOM_STEP}
              fallback={ZOOM_DEFAULT}
              onStep={stepZoom}
              onChange={(zoom) => setAppearance({ zoom })}
            />
          </Row>

          <Row
            title="Message text"
            description="Scales the message body only, leaving the list and the rest of the app where they are."
          >
            <PercentStepper
              label="Message text size"
              value={appearance.readingSize}
              min={READING_SIZE_MIN}
              max={READING_SIZE_MAX}
              step={READING_SIZE_STEP}
              fallback={READING_SIZE_DEFAULT}
              onStep={stepReadingSize}
              onChange={(readingSize) => setAppearance({ readingSize })}
            />
          </Row>
        </Section>

        <Section title="Density">
          <ChoiceCards
            label="Density"
            choices={DENSITIES}
            value={appearance.density}
            onChange={(density) => setAppearance({ density })}
          />
        </Section>

        <Section title="Font">
          <Row title="Interface font" description={FONTS.find((font) => font.id === appearance.font)?.hint ?? ''}>
            <select
              value={appearance.font}
              onChange={(e) => setAppearance({ font: e.target.value as typeof appearance.font })}
              aria-label="Interface font"
              className="px-3 py-1.5 bg-background border border-border rounded text-sm"
              style={{ fontFamily: cssVars['--app-font'] }}
            >
              {FONTS.map((font) => (
                <option key={font.id} value={font.id} style={{ fontFamily: font.stack }}>
                  {font.label}
                </option>
              ))}
            </select>
          </Row>

          <Row title="Reading font" description={findReadingFont(appearance.readingFont).hint}>
            <select
              value={appearance.readingFont}
              onChange={(e) => setAppearance({ readingFont: e.target.value as typeof appearance.readingFont })}
              aria-label="Reading font"
              className="px-3 py-1.5 bg-background border border-border rounded text-sm"
              style={{ fontFamily: cssVars['--reading-font'] }}
            >
              {READING_FONTS.map((font) => (
                <option key={font.id} value={font.id} style={{ fontFamily: font.stack }}>
                  {font.label}
                </option>
              ))}
            </select>
          </Row>
          <div className="text-sm text-muted-foreground">
            The reading font applies to plain-text mail and to messages that name no font of
            their own. A sender who styles their mail keeps their own typography.
          </div>
        </Section>

        <Section title="Message List">
          <div className="text-sm text-muted-foreground mb-3">
            How much of each message the list shows under the subject.
          </div>
          <ChoiceCards
            label="Preview lines"
            choices={SNIPPET_CHOICES}
            value={appearance.snippetLines}
            onChange={(snippetLines) => setAppearance({ snippetLines })}
          />
        </Section>

        <Section title="Layout">
          <Row
            title="Hover actions"
            description="Show archive, delete, mark-read and snooze on a message row when the pointer is over it."
          >
            <Switch
              label="Hover actions"
              checked={appearance.hoverActions}
              onChange={(hoverActions) => setAppearance({ hoverActions })}
            />
          </Row>

          <div className="text-sm text-muted-foreground mt-4 mb-3">
            How the actions above an open message are drawn. With names shown the toolbar is
            wider than the window and wraps onto a second line.
          </div>
          <ChoiceCards
            label="Button labels"
            choices={BUTTON_LABEL_CHOICES}
            value={appearance.buttonLabels}
            onChange={(buttonLabels) => setAppearance({ buttonLabels })}
          />
        </Section>

        <Section title="Motion">
          <div className="text-sm text-muted-foreground mb-3">
            Animated transitions — menus, panels, spinners and smooth scrolling.
          </div>
          <ChoiceCards
            label="Motion"
            choices={MOTION_CHOICES}
            value={appearance.motion}
            onChange={(motion) => setAppearance({ motion })}
          />
        </Section>

        <div className="flex items-center justify-between gap-4">
          <span className="text-sm text-muted-foreground">
            Appearance changes apply and save immediately — no need to press Save Changes.
          </span>
          <button
            type="button"
            onClick={() => resetAppearance()}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-border text-sm hover:bg-accent flex-shrink-0"
          >
            <RotateCcw className="h-4 w-4" />
            Reset to defaults
          </button>
        </div>
      </div>

      <aside className="space-y-3 xl:sticky xl:top-0" aria-label="Appearance preview">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Preview</h3>
        <AppearancePreview />
      </aside>
    </div>
  );
}
