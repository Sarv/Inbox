export const INBOX_PRIVACY_POLICY_URL = 'https://inbox.sarv.com/privacy-policy.html';

export function openInboxPrivacyPolicy(): void {
  void window.electronAPI.app.openExternal(INBOX_PRIVACY_POLICY_URL);
}

export function GmailPrivacyNotice() {
  return (
    <p className="text-xs leading-relaxed text-muted-foreground">
      Sarv Inbox uses Google access to read, send, organize and delete Gmail. Mail is stored in an
      encrypted database on this device. Optional AI can send parts of messages to the provider you
      connect, with your consent.{' '}
      <button type="button" onClick={openInboxPrivacyPolicy} className="font-medium text-primary underline underline-offset-2 hover:text-primary/80">
        Privacy policy
      </button>
    </p>
  );
}
