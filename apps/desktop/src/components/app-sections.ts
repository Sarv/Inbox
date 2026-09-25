// The list of screens the app can show.
//
// Its own leaf module, not a `type` inside AppSidebar.tsx, for two reasons: the
// list is needed as a VALUE at runtime (utils/active-section-storage.ts has to
// check a stored string against it, and a union type is erased by the
// compiler), and that check has no business importing a React component and its
// icon library to get at it.
export const APP_SECTIONS = [
  'mail',
  'teams',
  'chat',
  'meet',
  'webinar',
  'drive',
  'calendar',
  'contacts',
  'extensions',
  'ai-settings',
  'agent',
  'settings',
  'security',
] as const;

export type AppSection = (typeof APP_SECTIONS)[number];
