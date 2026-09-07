// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';

import { buildDeterministicConversation } from '../../../../src/services/conversation-heuristic';

const email = (over: Partial<any> = {}): any => ({
  id: 'e1',
  threadId: 't1',
  fromAddress: 'noreply@tasks.example',
  fromName: 'noreply',
  toAddress: 'advik.d@sarv.com',
  date: 1_700_000_000,
  tags: '||',
  cleanBody: '',
  rawBody: '',
  ...over,
});

describe('buildDeterministicConversation — standalone email passthrough', () => {
  it('renders a standalone notification VERBATIM (no cleaning/truncation), even with inline-only styling', () => {
    // The task-tracker notification (WI-1365) shape: an inline-styled comment blockquote (NO
    // <style> block, NO layout table) that the old cleaner unwrapped + truncated.
    const rawBody = `
      <div>
        <p>Sohum Jadeja wrote:</p>
        <blockquote style="border-left:3px solid #6c5ce7;padding-left:12px;background:#f5f6ff">
          After investigating the issue, please let me know a suitable time to schedule this.
        </blockquote>
        <a href="https://tasks.example/work-items/WI-1365" style="background:#6c5ce7;color:#fff;padding:12px">View work item</a>
      </div>`;
    const [msg] = buildDeterministicConversation([email({ rawBody })], 'advik.d@sarv.com');
    expect(msg).toBeTruthy();
    // Full comment survives; blockquote + inline styling preserved (verbatim).
    expect(msg.body).toContain('please let me know a suitable time to schedule this');
    expect(msg.body).toContain('View work item');
    expect(msg.body).toContain('<blockquote'); // structure NOT unwrapped
    expect(msg.body).toContain('border-left'); // inline design preserved
  });

  it('strips the sender signature card from a standalone message', () => {
    // The reported shape: one email, no quoted history, so the splitter finds no
    // boundaries — and the whole signature (sign-off, contact card, logo strip)
    // used to ride along into the bubble.
    const rawBody = `
      <div>
        <p>Hi Advik,</p>
        <p>As we discussed previously, we need to set up autoscaling for the docs service.
           Please let me know your availability so we can coordinate.</p>
        <p>I am planning to implement and validate these changes in the DEV environment first.</p>
        <p>Thanks</p>
        <table>
          <tr>
            <td><img src="cid:logo"></td>
            <td>Sohum Jadeja<br>DevOps Engineer<br>+91 7766554433<br>
                sohum.j@sarv.com<br>www.sarv.com | +91-9111-9111-00</td>
          </tr>
        </table>
      </div>`;
    const [msg] = buildDeterministicConversation([email({ rawBody })], 'advik.d@sarv.com');
    expect(msg.body).toContain('coordinate');
    expect(msg.body).toContain('DEV environment');
    expect(msg.body).not.toContain('DevOps Engineer');
    expect(msg.body).not.toContain('7766554433');
  });

  it('keeps a short "Thanks, <name>" reply that is ALL sign-off', () => {
    const rawBody = '<div><p>Thanks</p><p>Sohum</p></div>';
    const [msg] = buildDeterministicConversation([email({ rawBody })], 'advik.d@sarv.com');
    expect(msg.body).toContain('Thanks');
  });

  it('strips a "Thanks & Regards" signature whose card has NO phone, only company domains', () => {
    // Simran's shape: short body, then a sign-off + title + address + a
    // multi-domain links strip (no phone). Half the note, so the old 40% guard
    // + phone-required card rule both let it through.
    const rawBody = `
      <div>
        <p>Hello Team,</p>
        <p>Please find the mentioned details below:-</p>
        <p><b>Work-ID:</b> e44206a167b74dcda2ec112777a46122</p>
        <p>NOTE: session token will be valid for 7 days</p>
        <p>Thanks &amp; Regards</p>
        <table>
          <tr><td><img src="cid:pin"></td><td>
            <b>simran vyas</b><br>Devops Engineer<br>
            IT-10, EPIP RIICO Industrial Area, Sitapura (302022) Jaipur<br>
            <a href="https://sarv.com">sarv.com</a> | <a href="https://deepcall.com">deepcall.com</a> |
            <a href="https://wave.sarv.com">wave.sarv.com</a> | <a href="https://enquiry.ai">enquiry.ai</a>
          </td></tr>
        </table>
      </div>`;
    const [msg] = buildDeterministicConversation([email({ rawBody })], 'advik.d@sarv.com');
    expect(msg.body).toContain('Work-ID');
    expect(msg.body).toContain('session token');
    expect(msg.body).not.toContain('Devops Engineer');
    expect(msg.body).not.toContain('deepcall.com');
  });

  it('does not truncate a long single-message comment', () => {
    // Guards the exact reported symptom: the comment was cut at "…suitab".
    const tail = 'Please let me know a suitable time to schedule this call.';
    const rawBody = `<div><p>Sohum Jadeja wrote:</p><blockquote style="border-left:3px solid #6c5ce7">After investigating the issue, ${tail}</blockquote></div>`;
    const [msg] = buildDeterministicConversation([email({ rawBody })], 'advik.d@sarv.com');
    expect(msg.body).toContain(tail); // full sentence, not cut
  });
});
