export type DefaultAppTarget = 'email' | 'calendar';
export type DefaultAppResult<T> = { success: true; data: T } | { success: false; error: string };

export interface DefaultAppTargetStatus {
  status: 'default' | 'not-default' | 'unknown' | 'unsupported';
  canRequest: boolean;
  method: 'protocol' | 'file-association' | 'settings' | 'none';
  detail?: string;
}

export interface DefaultAppsState {
  platform: string;
  packaged: boolean;
  shouldPrompt: boolean;
  suppressPrompt: boolean;
  email: DefaultAppTargetStatus;
  calendar: DefaultAppTargetStatus;
}

export interface DefaultAppRequestResult {
  state: DefaultAppsState;
  outcome: 'default' | 'requested' | 'settings-opened' | 'unsupported';
  message: string;
}

export type ExternalOpenIntent =
  | { id: string; kind: 'compose'; to: string[]; cc: string[]; bcc: string[]; subject: string; body: string }
  | { id: string; kind: 'calendar-import'; text: string; filename: string }
  | { id: string; kind: 'calendar-link'; url: string };

export interface DefaultAppsAPI {
  getStatus: () => Promise<DefaultAppResult<DefaultAppsState>>;
  requestDefault: (target: DefaultAppTarget) => Promise<DefaultAppResult<DefaultAppRequestResult>>;
  openSettings: (target?: DefaultAppTarget) => Promise<DefaultAppResult<{ opened: boolean }>>;
  setPromptSuppressed: (suppressed: boolean) => Promise<DefaultAppResult<DefaultAppsState>>;
  getPendingOpen: () => Promise<DefaultAppResult<ExternalOpenIntent | null>>;
  acknowledgeOpen: (id: string) => Promise<DefaultAppResult<null>>;
  onPendingOpen: (listener: () => void) => () => void;
}
