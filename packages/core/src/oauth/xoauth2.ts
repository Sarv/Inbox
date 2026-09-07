// SASL XOAUTH2 SASL-IR payload used by IMAP/SMTP.
// Format: base64("user=" <email> \x01 "auth=Bearer " <access_token> \x01 \x01)
// See https://developers.google.com/gmail/imap/xoauth2-protocol

export function buildXOAuth2Token(email: string, accessToken: string): string {
  const sasl = `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`;
  return Buffer.from(sasl, 'utf8').toString('base64');
}
