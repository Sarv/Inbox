import { describe, expect, it } from 'vitest';

import { QUOTE_MARKERS, quoteMarkerCount, stripQuotedTail } from '../../../src/utils/quoted-text';

// What breaks if this file fails: looped-in mail that the chat view's
// structural split cannot read (plain text, localized clients, Outlook's
// header block) is never offered the AI split, or ordinary mail is offered it
// for history it does not have. `quoteMarkerCount` is only the fallback — it
// runs when the split found no quoted turns — so a count that is too HIGH
// spends AI on nothing and one that is too LOW hides a whole conversation.

describe('quoted-text seam', () => {
  // Breaks: the re-export stops being the library's corpus and drifts.
  it('re-exports the library markers and cut', () => {
    expect(QUOTE_MARKERS.length).toBeGreaterThan(5);
    expect(stripQuotedTail('Hi\n\nOn Mon, 1 Sep 2025, Bob <b@x.com> wrote:\n> old')).toBe('Hi');
  });
});

describe('quoteMarkerCount', () => {
  // Breaks: Outlook's separator and its From:/Sent: block are counted as two
  // messages, so a one-quote reply auto-opens as a looped-in thread.
  it("counts Outlook's '-----Original Message-----' plus From:/Sent: as ONE", () => {
    const text = [
      'Thanks, see below.',
      '',
      '-----Original Message-----',
      'From: Bob <bob@example.com>',
      'Sent: Monday, September 1, 2025 10:00 AM',
      'To: Me <me@example.com>',
      'Subject: Report',
      '',
      'Here is the report.',
    ].join('\n');
    expect(quoteMarkerCount(text, 'text')).toBe(1);
  });

  // Breaks: a looped-in email quoting two messages is under-counted and never
  // auto-opened in chat view.
  it('counts two English attributions as 2', () => {
    const text = [
      'Adding Carol.',
      '',
      'On Mon, Sep 1, 2025 at 10:00 AM Bob <bob@example.com> wrote:',
      'Sounds good to me.',
      'Let us meet on Friday.',
      'Best, Bob',
      '',
      'On Sun, Aug 31, 2025 at 9:00 AM Alice <alice@example.com> wrote:',
      'Shall we meet this week?',
    ].join('\n');
    expect(quoteMarkerCount(text, 'text')).toBe(2);
  });

  // Breaks: localized looped-in mail is never offered the AI split.
  it("counts a German 'Am … schrieb …:' attribution", () => {
    const text = [
      'Danke!',
      '',
      'Am 01.09.2025 um 10:00 schrieb Bob Meier <bob@example.de>:',
      'Hallo zusammen,',
      'anbei der Bericht.',
    ].join('\n');
    expect(quoteMarkerCount(text, 'text')).toBe(1);
  });

  // Breaks: a plain-text chain — the whole history is in '>' nesting — reads
  // as one quote, or zero.
  it("counts a 3-deep plain-text '>' chain as 3", () => {
    const text = [
      'Final answer.',
      '> Second reply',
      '>> First reply',
      '> > > Original message',
    ].join('\n');
    expect(quoteMarkerCount(text, 'text')).toBe(3);
  });

  // Breaks: ordinary prose that mentions an address or a date is treated as
  // quoted history and spends AI on a message with none.
  it('counts prose containing an address as 0', () => {
    const text = [
      'Hi team,',
      'Please write to alice@example.com with questions before 5 pm.',
      'As the auditor wrote: numbers first.',
      'Thanks',
    ].join('\n');
    expect(quoteMarkerCount(text, 'text')).toBe(0);
  });

  // Breaks: a Gmail HTML nest is under-counted because its attributions sit
  // inside converted blockquotes ("> On … wrote:").
  it('counts a Gmail HTML nest from the attributions inside its blockquotes', () => {
    const html = '<div dir="ltr">Latest reply</div><br><div class="gmail_quote">'
      + '<div class="gmail_attr">On Mon, Sep 1, 2025 at 10:00 AM Bob &lt;bob@x.com&gt; wrote:<br></div>'
      + '<blockquote class="gmail_quote"><div dir="ltr">Bob reply</div><br><div class="gmail_quote">'
      + '<div class="gmail_attr">On Sun, Aug 31, 2025 at 9:00 AM Alice &lt;alice@x.com&gt; wrote:<br></div>'
      + '<blockquote class="gmail_quote"><div dir="ltr">Alice original</div></blockquote></div>'
      + '</blockquote></div>';
    expect(quoteMarkerCount(html, 'html')).toBe(2);
  });

  // Breaks: Outlook HTML (header block per message) is counted as one.
  it("counts Outlook HTML's From:/Sent: blocks per message", () => {
    const html = '<p>Thanks all</p>'
      + '<div style="border-top:solid #E1E1E1 1.0pt"><p><b>From:</b> Bob &lt;bob@x.com&gt;<br>'
      + '<b>Sent:</b> Monday<br><b>To:</b> Me</p></div><p>Bob text</p><p>More Bob text</p>'
      + '<p>-----Original Message-----<br>From: Alice &lt;alice@x.com&gt;<br>Sent: Sunday<br>To: Bob</p>'
      + '<p>Alice text</p>';
    expect(quoteMarkerCount(html, 'html')).toBe(2);
  });

  // Breaks: running plain text through the HTML converter collapses its
  // newlines, erasing the '>' structure and every line-anchored marker.
  it('never runs plain text through the HTML converter', () => {
    const text = 'Reply\n> quoted\n> > older';
    expect(quoteMarkerCount(text, 'text')).toBe(2);
    // The same bytes read as HTML collapse onto one line with no attribution
    // (and HTML nesting is never read): 0 — which is exactly why the caller
    // has to say which it has.
    expect(quoteMarkerCount(text, 'html')).toBe(0);
  });

  // Breaks: Outlook's long underscore rule, or a user's own rule above their
  // signature, counts as a quoted message.
  it('does not count an underscore rule on its own', () => {
    expect(quoteMarkerCount(`Thanks\n${'_'.repeat(32)}\nJane Doe\nACME`, 'text')).toBe(0);
  });

  // Breaks: a crash on the first email's missing body blanks the thread view.
  it('returns 0 for an empty or missing body', () => {
    expect(quoteMarkerCount('', 'text')).toBe(0);
    expect(quoteMarkerCount('   ', 'html')).toBe(0);
    expect(quoteMarkerCount(null, 'text')).toBe(0);
    expect(quoteMarkerCount(undefined, 'html')).toBe(0);
    expect(quoteMarkerCount('<img src="x.png">', 'html')).toBe(0);
  });

  // Breaks: CRLF mail (most Outlook plain text) loses its line anchors.
  it('handles CRLF line endings', () => {
    const text = 'Ok\r\n\r\nOn Mon, Sep 1, 2025, Bob <b@x.com> wrote:\r\n> hi\r\n';
    expect(quoteMarkerCount(text, 'text')).toBe(1);
  });

  // Breaks: a dense run of short replies collapses into one because hits were
  // merged by chaining rather than from the first hit of a group.
  it('merges hits within 2 lines of the first hit, not by chaining', () => {
    const text = [
      'On Mon, Sep 1, 2025, A <a@x.com> wrote:',
      'ok',
      'On Sun, Aug 31, 2025, B <b@x.com> wrote:',
      'fine',
      'On Sat, Aug 30, 2025, C <c@x.com> wrote:',
    ].join('\n');
    // Lines 0, 2, 4: 0–2 merge; 4 is 4 lines from the group's first hit.
    expect(quoteMarkerCount(text, 'text')).toBe(2);
  });

  // --- One quoted message must never read as two (review probes). Under the
  // chat rules 2+ means auto-open AND an automatic AI split, so each of these
  // would spend AI on single-quote (or no-quote) mail, against decision 2. ---

  // Breaks: the separator in its own paragraph was placed on the blank line
  // ABOVE it (the markers open with `^\s*` under /m), 3 lines from its From:
  // block, and counted as a second message.
  it("counts Outlook HTML with the separator in its own <p> as ONE", () => {
    const html = '<p>Thanks all</p><p>-----Original Message-----</p>'
      + '<p>From: Alice &lt;alice@x.com&gt;<br>Sent: Monday<br>To: Bob</p><p>Hi Bob</p>';
    expect(quoteMarkerCount(html, 'html')).toBe(1);
  });

  // Breaks: Apple's "Begin forwarded message:" in its own paragraph counted
  // apart from the From:/Subject: block it introduces.
  it("counts an Apple forward with 'Begin forwarded message:' in its own <p> as ONE", () => {
    const html = '<p>FYI</p><p>Begin forwarded message:</p>'
      + '<p>From: Alice &lt;alice@x.com&gt;<br>Subject: Hi<br>Date: 1 Sep 2025<br>To: Bob</p><p>text</p>';
    expect(quoteMarkerCount(html, 'html')).toBe(1);
  });

  // Breaks: plain-text Outlook with a blank line typed AFTER the separator
  // (the existing Outlook test only has one before it).
  it('counts plain Outlook with blank lines around the separator as ONE', () => {
    const text = 'Ok\n\n-----Original Message-----\n\nFrom: Bob <bob@x.com>\nSent: Monday\nTo: Me\n\nbody';
    expect(quoteMarkerCount(text, 'text')).toBe(1);
    expect(quoteMarkerCount(text.replace(/\n/g, '\r\n'), 'text')).toBe(1);
  });

  // Breaks: a reply whose own text has a line starting "On" ("On it!", "On
  // Monday we…") within 300 chars above the real attribution: `^On…wrote:`
  // matches from the prose line, far from the attribution's own hit.
  it('does not count a prose line starting with "On" above the attribution', () => {
    for (const prose of ['On it! I will send the deck today.', 'On Monday we sign.', 'On the whole, fine.']) {
      const text = [
        prose,
        'Thanks',
        '',
        'On Mon, Sep 1, 2025 at 10:00 AM Bob <bob@example.com> wrote:',
        '> Can you send the deck?',
      ].join('\n');
      expect(quoteMarkerCount(text, 'text'), prose).toBe(1);
    }
  });

  // Breaks: the prose-line fix swallows a genuine SECOND attribution below the
  // first — two quoted messages still count as two.
  it('still counts two attributions under a prose line starting with "On"', () => {
    const text = [
      'On it.',
      '',
      'On Mon, Sep 1, 2025 at 10:00 AM Bob <bob@example.com> wrote:',
      '> Sure, adding Alice.',
      '> Thanks',
      '>',
      '> On Sun, Aug 31, 2025 at 9:00 AM Alice <alice@example.com> wrote:',
      '>> Can you send the deck?',
    ].join('\n');
    expect(quoteMarkerCount(text, 'text')).toBe(2);
  });

  // Breaks: Gmail's "Indent more" (formatting-only nested blockquotes, no
  // quote at all) converts to `> >` and read as two quoted messages.
  it('counts formatting-only nested HTML blockquotes (Gmail "Indent more") as 0', () => {
    const indent = '<blockquote style="margin:0 0 0 40px;border:none;padding:0px">';
    const html = `<div>Hello</div>${indent}${indent}<div>indented</div></blockquote></blockquote><div>bye</div>`;
    expect(quoteMarkerCount(html, 'html')).toBe(0);
  });

  // Breaks: the case-insensitive `On <weekday>…wrote:` marker fires inside
  // prose ("meet on Friday") and runs down to the NEXT attribution; if that
  // span widened the first group, two quoted messages would read as one.
  it('does not let a prose "on Friday" span merge two attributions', () => {
    const text = [
      'On Mon, Sep 1, 2025 at 10:00 AM Bob <bob@example.com> wrote:',
      'Let us meet on Friday.',
      'Best, Bob',
      '',
      'On Sun, Aug 31, 2025 at 9:00 AM Alice <alice@example.com> wrote:',
      'Shall we meet?',
    ].join('\n');
    expect(quoteMarkerCount(text, 'text')).toBe(2);
  });

  // Breaks: extra vertical space between a separator and its header block (a
  // run of blank lines) reads as distance, and one quote counts as two.
  it('treats a run of blank lines as one line of distance', () => {
    const text = 'Ok\n\n-----Original Message-----\n\n\n\nFrom: Bob <bob@x.com>\nSent: Monday\n\nbody';
    expect(quoteMarkerCount(text, 'text')).toBe(1);
  });

  // Breaks: collapsing blank lines too eagerly merges a Gmail chain of
  // one-line replies ("ok"), whose attributions are only 3 lines apart.
  it('still counts each attribution in a chain of one-line replies', () => {
    const text = [
      'Sure',
      '',
      'On Mon, Sep 1, 2025 at 10:00 AM Bob <bob@example.com> wrote:',
      '> ok',
      '>',
      '> On Sun, Aug 31, 2025 at 9:00 AM Alice <alice@example.com> wrote:',
      '>> Can we meet?',
    ].join('\n');
    expect(quoteMarkerCount(text, 'text')).toBe(2);
  });
});

