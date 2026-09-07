import { describe, it, expect } from 'vitest';

import { classifyEmail, isConversationEmail } from '../../../../src/utils/email-classification';

describe('classifyEmail', () => {
  it('treats a plain hand-written reply as human', () => {
    const r = classifyEmail({
      rawBody: '<div><p>Hi Advik,</p><p>Please find the API doc attached. Thanks!</p></div>',
      messageId: '<CAF=abc123@mail.gmail.com>',
      fromAddress: 'mitali@example.com',
    });
    expect(r.kind).toBe('human');
  });

  it('keeps a long hand-written email with bold/lists human', () => {
    const r = classifyEmail({
      rawBody:
        '<p>Hi team,</p><p><b>EMAIL_RQ_182:</b> Solution should support MFA.</p>' +
        '<ul><li>Point one</li><li>Point two</li></ul><p>Please confirm.</p>'.repeat(6),
      messageId: '<x@mail.gmail.com>',
      fromAddress: 'person@company.com',
    });
    expect(r.kind).toBe('human');
  });

  it('keeps a verbose Outlook/Word email human (no false low-text-ratio / designed flag)', () => {
    // Outlook: >10KB of mso markup, inline styles on every block, a layout table
    // — but a genuine one-line reply. Must NOT be flagged automated.
    const outlook =
      '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>p.MsoNormal{margin:0}</style></head>' +
      '<body><table role="presentation" style="width:100%"><tr><td style="padding:0">' +
      '<div style="margin:0"><p style="margin:0"><b>Hi Mitali,</b></p>' +
      '<p style="margin:0">As discussed, please share the API doc. Thanks!</p></div>' +
      '</td></tr></table>' + `<!--${'x'.repeat(12000)}-->` + '</body></html>';
    const r = classifyEmail({ rawBody: outlook, messageId: '<x@mail.gmail.com>', fromAddress: 'advik@corp.com' });
    expect(r.kind).toBe('human');
  });

  it('flags a 1x1 tracking pixel as automated', () => {
    const r = classifyEmail({
      rawBody: '<p>Sale!</p><img src="https://t.example/o.gif" width="1" height="1">',
      fromAddress: 'deals@shop.com',
    });
    expect(r.kind).toBe('automated');
    expect(r.signals).toContain('tracking-pixel');
  });

  it('flags an unrendered template placeholder as automated', () => {
    expect(classifyEmail({ rawBody: '<p>Hello {{first_name}},</p>' }).kind).toBe('automated');
    expect(classifyEmail({ rawBody: '<p>Hi %FIRST_NAME%</p>' }).kind).toBe('automated');
    expect(classifyEmail({ rawBody: '<p>Dear [NAME]</p>' }).kind).toBe('automated');
  });

  it('flags an ESP Message-ID as automated', () => {
    expect(classifyEmail({ rawBody: '<p>hi</p>', messageId: '<abc.123@sendgrid.net>' }).kind).toBe('automated');
    expect(classifyEmail({ rawBody: '<p>hi</p>', messageId: '<abc@bounces.amazonses.com>' }).kind).toBe('automated');
    // A real client Message-ID must stay human.
    expect(classifyEmail({ rawBody: '<p>hi</p>', messageId: '<abc@mail.gmail.com>' }).kind).toBe('human');
  });

  it('flags a no-reply / notifications sender as automated', () => {
    expect(classifyEmail({ rawBody: '<p>Task updated</p>', fromAddress: 'no-reply@tasks.example' }).kind).toBe('automated');
    expect(classifyEmail({ rawBody: '<p>Task updated</p>', fromAddress: 'notifications@jira.com' }).kind).toBe('automated');
  });

  it('does NOT flag a lone "unsubscribe" word in a human email (below threshold)', () => {
    const r = classifyEmail({
      rawBody: '<p>You can unsubscribe from the internal newsletter in settings. Anyway, see you Monday!</p>',
      messageId: '<x@mail.gmail.com>',
      fromAddress: 'colleague@company.com',
    });
    expect(r.kind).toBe('human');
  });

  it('flags a real marketing email (tracking pixel + unsubscribe) as automated', () => {
    const r = classifyEmail({
      rawBody:
        '<table role="presentation"><tr><td>Big Sale</td></tr></table>' +
        '<img src="https://t.brand/open.gif" width="1" height="1">' +
        '<a href="https://x/u">Unsubscribe</a> · <a href="https://x/p">Manage preferences</a>',
      fromAddress: 'news@brand.com',
    });
    expect(r.kind).toBe('automated');
  });

  it('isConversationEmail is the human predicate', () => {
    expect(isConversationEmail({ rawBody: '<p>See you tomorrow.</p>', messageId: '<x@mail.gmail.com>' })).toBe(true);
    expect(isConversationEmail({ rawBody: '<p>Hi {{name}}</p>' })).toBe(false);
  });
});
