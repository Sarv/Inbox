import { Check, Minus, Monitor, Moon, Paperclip, Plus, RotateCcw, Star, Sun } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  ACCENTS,
  DENSITIES,
  FONTS,
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  appearanceCssVars,
  resetAppearance,
  setAppearance,
  stepZoom,
  useAppearance,
  useResolvedTheme,
  type ThemeMode,
} from '../../appearance';
import { Tooltip } from '../Tooltip';

const THEME_MODES: { id: ThemeMode; label: string; hint: string; Icon: typeof Sun }[] = [
  { id: 'light', label: 'Light', hint: 'Always light, whatever the OS is set to.', Icon: Sun },
  { id: 'dark', label: 'Dark', hint: 'Always dark, whatever the OS is set to.', Icon: Moon },
  { id: 'system', label: 'System', hint: 'Follows your OS, and switches with it.', Icon: Monitor },
];

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
 * A miniature of the message list, styled by the SAME custom properties the
 * real one reads.
 *
 * It exists because the Settings screen covers the list it is changing: without
 * it, picking a density means saving, navigating back to the inbox, looking,
 * and navigating in again. The preview is intentionally built from the real
 * `.list-row` / `.brand-fill` classes rather than a hand-drawn imitation, so it
 * cannot drift away from what the list actually does.
 */
function AppearancePreview() {
  const messages = [
    { sender: 'Devendra Kumar', subject: 'Production Server Details', snippet: 'Thanks — I have access now', time: 'Sep 3', unread: true, starred: true },
    { sender: 'Product Hunt Daily', subject: 'Ship fast and break things', snippet: 'chat windows, sparkles, and agent…', time: '8:39 AM', unread: false, starred: false },
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
          <span className={`flex-1 truncate text-sm ${message.unread ? 'font-semibold text-foreground' : 'text-foreground'}`}>
            {message.subject}
            <span className="text-muted-foreground font-normal"> — {message.snippet}</span>
          </span>
          <Paperclip className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0">{message.time}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Appearance — theme, accent, text size, density and font.
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
          <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="Theme">
            {THEME_MODES.map(({ id, label, hint, Icon }) => {
              const active = appearance.theme === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setAppearance({ theme: id })}
                  className={`flex-1 min-w-[10rem] text-left px-4 py-3 rounded-lg border-2 transition-colors ${
                    active ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/40'
                  }`}
                >
                  <div className="flex items-center gap-2 font-medium">
                    <Icon className="h-4 w-4" />
                    {label}
                    {active && <Check className="h-4 w-4 ml-auto text-primary" />}
                  </div>
                  <div className="text-sm text-muted-foreground mt-1">{hint}</div>
                </button>
              );
            })}
          </div>
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
            <button
              type="button"
              role="switch"
              aria-checked={appearance.darkenEmails}
              aria-label="Dark email bodies"
              onClick={() => setAppearance({ darkenEmails: !appearance.darkenEmails })}
              className={`relative w-11 h-6 rounded-full transition-colors ${appearance.darkenEmails ? 'bg-primary' : 'bg-muted'}`}
            >
              <span
                className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  appearance.darkenEmails ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
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
            <button
              type="button"
              role="switch"
              aria-checked={appearance.gradientAccents}
              aria-label="Gradient accents"
              onClick={() => setAppearance({ gradientAccents: !appearance.gradientAccents })}
              className={`relative w-11 h-6 rounded-full transition-colors ${appearance.gradientAccents ? 'bg-primary' : 'bg-muted'}`}
            >
              <span
                className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  appearance.gradientAccents ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </Row>
        </Section>

        <Section title="Text Size">
          <Row
            title="Interface zoom"
            description="Scales the whole app, exactly like Cmd/Ctrl + and −  — which now change this setting, so the size survives a restart."
          >
            <div className="flex items-center gap-3">
              <Tooltip content="Smaller" delayMs={40}>
                <button
                  type="button"
                  aria-label="Decrease text size"
                  disabled={appearance.zoom <= ZOOM_MIN}
                  onClick={() => setAppearance({ zoom: stepZoom(appearance.zoom, 'out') })}
                  className="p-1.5 rounded border border-border hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Minus className="h-4 w-4" />
                </button>
              </Tooltip>
              <input
                type="range"
                min={ZOOM_MIN}
                max={ZOOM_MAX}
                step={ZOOM_STEP}
                value={appearance.zoom}
                aria-label="Interface zoom"
                onChange={(e) => setAppearance({ zoom: Number(e.target.value) })}
                className="w-48 accent-primary"
              />
              <Tooltip content="Larger" delayMs={40}>
                <button
                  type="button"
                  aria-label="Increase text size"
                  disabled={appearance.zoom >= ZOOM_MAX}
                  onClick={() => setAppearance({ zoom: stepZoom(appearance.zoom, 'in') })}
                  className="p-1.5 rounded border border-border hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </Tooltip>
              <span className="w-12 text-sm tabular-nums text-right">{appearance.zoom}%</span>
              {appearance.zoom !== ZOOM_DEFAULT && (
                <button
                  type="button"
                  onClick={() => setAppearance({ zoom: ZOOM_DEFAULT })}
                  className="text-sm text-primary hover:underline"
                >
                  Reset
                </button>
              )}
            </div>
          </Row>
        </Section>

        <Section title="Density">
          <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="Density">
            {DENSITIES.map((density) => {
              const active = appearance.density === density.id;
              return (
                <button
                  key={density.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setAppearance({ density: density.id })}
                  className={`flex-1 min-w-[10rem] text-left px-4 py-3 rounded-lg border-2 transition-colors ${
                    active ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/40'
                  }`}
                >
                  <div className="flex items-center gap-2 font-medium">
                    {density.label}
                    {active && <Check className="h-4 w-4 ml-auto text-primary" />}
                  </div>
                  <div className="text-sm text-muted-foreground mt-1">{density.hint}</div>
                </button>
              );
            })}
          </div>
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
