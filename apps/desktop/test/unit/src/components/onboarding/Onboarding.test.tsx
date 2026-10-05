// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AISetupStepProps } from '../../../../../src/components/onboarding/AISetupStep';
import type { EmailSetupResult } from '../../../../../src/components/onboarding/EmailSetupStep';
import { Onboarding } from '../../../../../src/components/onboarding/Onboarding';
import { applyOnboardingAIChoice, suspendOnboardingAI } from '../../../../../src/services/onboarding-ai-choice';
import { cleanup, fire, render, settle } from '../../../../helpers/render';

const state = vi.hoisted(() => ({ accounts: [] as any[], activeAccountId: null as string | null }));
let emailProps: any;
let aiProps: AISetupStepProps;
let avProps: any;
vi.mock('../../../../../src/store/email-store', () => ({ useEmailStore: { getState: () => state } }));
vi.mock('../../../../../src/services/onboarding-ai-choice', () => ({
  suspendOnboardingAI: vi.fn(), applyOnboardingAIChoice: vi.fn(async () => {}),
}));
vi.mock('../../../../../src/components/onboarding/EmailSetupStep', () => ({ EmailSetupStep: (props: any) => {
  emailProps = props;
  return <><h1>Email {props.stage}</h1><input aria-label="Email draft" defaultValue="" /><button onClick={() => props.onStageChange('connection')}>Pick provider</button></>;
} }));
vi.mock('../../../../../src/components/onboarding/AISetupStep', () => ({ AISetupStep: (props: AISetupStepProps) => {
  aiProps = props;
  return <><h1>AI {props.stage}</h1><button onClick={props.onBackToEmail}>Back to email</button><button onClick={() => props.onComplete({ enabled: false })}>Skip AI</button></>;
} }));
vi.mock('../../../../../src/components/onboarding/AntivirusSetupStep', () => ({ AntivirusSetupStep: (props: any) => {
  avProps = props;
  return <><h1>Antivirus {props.stage}</h1><button onClick={props.onBack}>Back to AI</button><button onClick={() => props.onComplete({ enabled: false })}>Skip antivirus</button></>;
} }));

const email: EmailSetupResult = { accountId: 'acct', email: 'person@example.com', providerId: 'gmail', authMethod: 'oauth2', sendingConnected: true, sarvConnected: false };
const click = (label: string) => fire([...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === label) ?? null, 'click');
const callback = async (action: () => void) => { const { act } = await import('react'); act(action); await settle(); };
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); state.accounts = []; state.activeAccountId = null;
});
afterEach(cleanup);

describe('provider-first onboarding orchestration', () => {
  it('starts at email selection and saves a pending flag without completing setup', () => {
    render(<Onboarding onComplete={vi.fn()} />);
    expect(emailProps.stage).toBe('provider'); expect(emailProps.active).toBe(true);
    expect(aiProps.active).toBe(false); expect(avProps.active).toBe(false);
    expect(localStorage.getItem('sarvinbox-onboarding-pending')).toBe('true');
    expect(localStorage.getItem('sarvinbox-onboarding-complete')).toBeNull();
    expect(suspendOnboardingAI).toHaveBeenCalledOnce();
    click('Pick provider'); expect(emailProps.stage).toBe('connection');
    expect(document.activeElement?.textContent).toBe('Email connection');
  });

  it('uses Sarv mailbox sign-in to go directly to its model selection', async () => {
    render(<Onboarding onComplete={vi.fn()} />);
    await callback(() => emailProps.onConnected({ ...email, providerId: 'sarv', sarvConnected: true }));
    expect(aiProps.stage).toBe('model'); expect(aiProps.preferSarv).toBe(true);
    expect(aiProps.preferSarvEmail).toBe(email.email);
    expect(document.querySelector('[aria-current="step"]')?.textContent).toContain('Model');
    expect(document.querySelectorAll('ol li')).toHaveLength(4);
  });

  it('asks other email users for AI and keeps optional steps until Open inbox', async () => {
    const done = vi.fn(); render(<Onboarding onComplete={done} />);
    await callback(() => emailProps.onConnected(email));
    expect(aiProps.stage).toBe('provider'); expect(aiProps.preferSarv).toBe(false);
    click('Skip AI'); expect(avProps.active).toBe(true); expect(avProps.accountId).toBe('acct');
    click('Skip antivirus');
    expect(done).not.toHaveBeenCalled(); expect(applyOnboardingAIChoice).not.toHaveBeenCalled();
    expect(localStorage.getItem('sarvinbox-onboarding-complete')).toBeNull();
    click('Open inbox'); await settle();
    expect(applyOnboardingAIChoice).toHaveBeenCalledWith(false);
    expect(done).toHaveBeenCalledOnce();
    expect(localStorage.getItem('sarvinbox-onboarding-complete')).toBe('true');
    expect(localStorage.getItem('sarvinbox-onboarding-pending')).toBeNull();
  });

  it('retains mounted drafts and connections while moving Back and editing the summary', async () => {
    render(<Onboarding onComplete={vi.fn()} />);
    const draft = document.querySelector('input') as HTMLInputElement;
    draft.value = 'saved draft';
    await callback(() => emailProps.onConnected(email));
    click('Skip AI'); click('Back to AI'); click('Back to email');
    expect(document.querySelector('input')).toBe(draft); expect(draft.value).toBe('saved draft');
    await callback(() => emailProps.onConnected(email));
    click('Skip AI'); click('Skip antivirus'); click('Edit antivirus');
    expect(avProps.active).toBe(true); click('Skip antivirus'); click('Edit AI');
    expect(aiProps.active).toBe(true);
  });

  it('only enables the tested model when setup finishes', async () => {
    render(<Onboarding onComplete={vi.fn()} />);
    await callback(() => emailProps.onConnected(email));
    await callback(() => aiProps.onComplete({ enabled: true, providerName: 'OpenAI', modelName: 'chosen-model' }));
    expect(applyOnboardingAIChoice).not.toHaveBeenCalled();
    await callback(() => avProps.onComplete({ enabled: true, providerName: 'Sarv Antivirus' }));
    expect(document.body.textContent).toContain('OpenAI · chosen-model');
    click('Open inbox'); await settle(); expect(applyOnboardingAIChoice).toHaveBeenCalledWith(true);
  });

  it('keeps automatic AI off after enabling a model then revisiting and skipping AI', async () => {
    render(<Onboarding onComplete={vi.fn()} />);
    await callback(() => emailProps.onConnected(email));
    await callback(() => aiProps.onComplete({ enabled: true, providerName: 'OpenAI', modelName: 'chosen-model' }));
    click('Back to AI'); click('Skip AI'); click('Skip antivirus'); click('Open inbox'); await settle();
    expect(applyOnboardingAIChoice).toHaveBeenCalledWith(false);
  });

  it('resumes an interrupted setup after account creation without reconnecting email', () => {
    localStorage.setItem('sarvinbox-onboarding-pending', 'true');
    localStorage.setItem('sarvinbox-onboarding-email', '{"accountId":"acct","sendingConnected":true}');
    state.accounts = [{ id: 'acct', email: 'person@sarv.com', smtpConfigured: true, imapConfig: { host: 'imap.sarv.com', authMethod: 'oauth2', oauthProvider: 'sarv' } }];
    state.activeAccountId = 'acct';
    render(<Onboarding onComplete={vi.fn()} />);
    expect(aiProps.active).toBe(true); expect(aiProps.stage).toBe('model');
    expect(aiProps.preferSarvEmail).toBe('person@sarv.com');
    expect(emailProps.active).toBe(false);
  });

  it('returns to email when interrupted before sending was verified or deferred', () => {
    localStorage.setItem('sarvinbox-onboarding-pending', 'true');
    state.accounts = [{ id: 'acct', email: 'person@sarv.com', smtpConfigured: true, imapConfig: { host: 'imap.sarv.com', authMethod: 'oauth2', oauthProvider: 'sarv' } }];
    state.activeAccountId = 'acct';
    render(<Onboarding onComplete={vi.fn()} />);
    expect(emailProps.active).toBe(true); expect(emailProps.stage).toBe('connection');
    expect(aiProps.active).toBe(false);
  });

  it('contains keyboard focus and prevents mailbox shortcuts behind setup', () => {
    render(<Onboarding onComplete={vi.fn()} />);
    const listener = vi.fn(); document.addEventListener('keydown', listener);
    const button = document.querySelector('[data-active-step] button') as HTMLButtonElement;
    button.focus(); fire(button, 'keydown', { key: 'j' }); expect(listener).not.toHaveBeenCalled();
    fire(button, 'keydown', { key: 'Tab' }); expect(document.activeElement?.getAttribute('aria-label')).toBe('Email draft');
    fire(document.activeElement, 'keydown', { key: 'Tab', shiftKey: true }); expect(document.activeElement).toBe(button);
    document.removeEventListener('keydown', listener);
  });

  it('keeps progress and connections available when final saving fails', async () => {
    vi.mocked(applyOnboardingAIChoice).mockRejectedValueOnce(new Error('bridge unavailable'));
    const done = vi.fn(); render(<Onboarding onComplete={done} />);
    await callback(() => emailProps.onConnected(email)); click('Skip AI'); click('Skip antivirus');
    click('Open inbox'); await settle();
    expect(done).not.toHaveBeenCalled(); expect(localStorage.getItem('sarvinbox-onboarding-pending')).toBe('true');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('connections are preserved');
    click('Open inbox'); await settle(); expect(done).toHaveBeenCalledOnce();
  });
});
