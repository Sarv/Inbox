/** App-owned guidance. Never consults a provider, searches mail, or performs an action. */
const CAPABILITIES = [
  'I can search your selected connected accounts, including Sent and Archive, read available message bodies and permitted attachments, and answer with links to the original sources.',
  'I can review unread conversations, including uncategorized unread mail, and help mark matching emails read or unread. Review cards also let you manually select conversations and choose Archive or Delete; Delete moves them to Trash.',
  'Use Draft email to prepare an email from the full chat context, then review it in the composer and choose whether to send it yourself. I check local calendar availability only while preparing a meeting draft.',
  'Try “What quote did I send to TCS?”, “Find meeting invitations received today”, “Review my unread emails”, or “Mark all BigBlueButton emails unread”.',
].join('\n\n');

const GREETING = /^(?:hi|hello|hey|good morning|good afternoon|good evening)(?:\s+(?:there|inbox agent|assistant))?[!.?]*$/i;
const HELP = /^(?:help(?:\s+me)?|what can (?:you|inbox agent) do(?:\s+for me)?|how can you help(?:\s+me)?(?:\s+with (?:my\s+)?(?:inbox|email|emails|mail))?|can you help(?:\s+me)?|what are your (?:capabilities|features)|show(?:\s+me)? your (?:capabilities|features)|how (?:do|can) i use (?:you|inbox agent)|what tasks can you help with)[!.?]*$/i;

function imperative(question: string): string {
  return question.replace(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?/i, '');
}

export function inboxAssistantCapabilityReply(question: string): string | undefined {
  if (typeof question !== 'string' || question.length > 4_000) return undefined;
  const value = question.trim().replace(/\s+/g, ' ');
  if (!value) return undefined;
  if (GREETING.test(value)) return 'Hi! Ask me to find an email, summarize a conversation with source links, or review your unread mail. Ask “What can you do?” for the available features.';
  const help = value.replace(/^(?:hi|hello|hey)[!,.:]?\s+/i, '');
  if (HELP.test(help)) return CAPABILITIES;

  const command = imperative(value);
  // Only leading imperatives enter these paths. Quoted instructions, questions
  // about past actions, and searches mentioning deletion/sending stay searches.
  const calendarWrite = /^(?:schedule|reschedule|book|cancel|delete|remove)\s+(?!of\b)(?:.{0,100}\s+)?(?:meetings?|appointments?|events?|calls?)\b/i.test(command)
    || /^(?:create|add)\s+(?:(?:a|an|the|my|new|another|this|that)\s+){0,2}(?:calendar\s+)?(?:meetings?|appointments?|events?|calls?)\b(?!\s+(?:summary|list|report|overview|recap|analysis|table)\b)/i.test(command);
  if (calendarWrite) {
    return 'I cannot create, schedule, reschedule or cancel calendar events from this chat command. No mail or calendar events were changed, and no email was sent. Open Calendar and choose New event, or open an existing event to edit it or choose Delete event. To suggest available times in an email, use Draft email and the meeting fields, then review the draft in the composer.';
  }
  if (/^(?:delete|archive|trash|remove)\s+(?:.{0,120}\s+)?(?:emails?|mail|messages?|conversations?|threads?|inbox)\b/i.test(command)
    || /^(?:delete|archive|trash)\s+(?:all|these|those|them)[!.?]*$/i.test(command)) {
    return 'I cannot archive or delete mail from this chat command. No mail was changed. In Mail, select the conversations and choose Archive or Delete; Delete moves them to Trash. You can also ask “Review my unread emails”, manually select conversations in the review card, then choose Archive or Delete and review the confirmation.';
  }
  if (/^send\s+(?:(?:an?|the|this|that|my)\s+)?(?:emails?|messages?|reply|replies|draft|invitation)\b/i.test(command)) {
    return 'I can prepare a draft, but I cannot send email from this chat command. No email was sent and no mail was changed. Use Draft email to prepare a message from this chat, or open Compose. Review the recipients, subject and body in the composer, then choose Send yourself.';
  }
  return undefined;
}
