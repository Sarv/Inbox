import { addTag, hasTag, removeTag, type EmailRecord } from '@sarvinbox/core';

/**
 * Put a label (by name) on an email or take it off: the label's name as a
 * tag, local only, like an AI category. The one way both the mail view
 * (`emails:setLabel`) and the Inbox Agent's change sets do it.
 *
 * Answers what happened, so a caller can tell a change from "already so":
 * `missing` when the email is not in this account's store.
 */
export async function setEmailLabel(
  storage: { getEmail(id: string): Promise<Pick<EmailRecord, 'tags'> | null>; updateEmail(id: string, updates: { tags: string }): Promise<unknown> },
  emailId: string, name: string, on: boolean,
): Promise<'changed' | 'unchanged' | 'missing'> {
  const label = (name || '').trim();
  if (!label) throw new Error('Label is required');
  const email = await storage.getEmail(emailId);
  if (!email) return 'missing';
  const tags = email.tags || '||';
  if (hasTag(tags, label) === on) return 'unchanged';
  await storage.updateEmail(emailId, { tags: on ? addTag(tags, label) : removeTag(tags, label) });
  return 'changed';
}
