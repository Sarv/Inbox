// User-defined labels. A label is applied to an email by adding its name as a
// tag on the email's `tags` column (the same tag mechanism folders/flags use);
// the labels table records which tag names are user labels and their color.

export interface Label {
  id: string;
  name: string;
  /** Hex color, e.g. "#2563eb". */
  color: string;
  /**
   * True when the user opted to mirror this label onto the mail server (an IMAP
   * folder was CREATEd for it), so it's visible in the provider's own webmail —
   * not just inside this app. Local-only labels leave this false.
   */
  syncedToServer?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LabelInput {
  name: string;
  color?: string;
  /**
   * Request flag (create-time only): also CREATE this label as a folder on the
   * account's mail server so it shows in webmail. Opt-in; defaults to false
   * (local-only). The stored result is reflected in `Label.syncedToServer`.
   */
  syncToServer?: boolean;
}
