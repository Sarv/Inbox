// The user's answer to "Send crash reports to Sarv?" (CASA L-8).
//
// Crash reporting is OFF until the user says yes. The MAIN process owns the
// answer (crash-reports.json in userData — Sentry reads it at startup, before
// any window exists), so the renderer never keeps its own copy in the
// settings blob: it reads main's answer over IPC and records a new one the
// same way. This store is the renderer's view of it, shared by the renderer's
// Sentry gate, the first-launch consent dialog and Settings → General.

import { create } from 'zustand';

/** `unasked`: the user has not answered yet — nothing is sent, and the dialog asks. */
export type CrashReportChoice = 'yes' | 'no' | 'unasked';

interface CrashReportChoiceState {
  /** Main's answer, or null until it has been read (or when it can't be). */
  choice: CrashReportChoice | null;
}

export const useCrashReportChoiceStore = create<CrashReportChoiceState>(() => ({ choice: null }));

/** The answer as React state. */
export const useCrashReportChoice = (): CrashReportChoice | null => useCrashReportChoiceStore((s) => s.choice);

/** The answer outside React (the renderer's Sentry filters read it per event). */
export const crashReportChoice = (): CrashReportChoice | null => useCrashReportChoiceStore.getState().choice;

/** The wording of what a report carries — one copy, for the dialog and Settings. */
export const CRASH_REPORT_DISCLOSURE =
  'When Sarv Inbox runs into an error, it can send a report to Sarv so the problem can be fixed. A report has ' +
  'the error, the app version, your operating system and language, your mail server’s name, and a trail of ' +
  'recent app activity such as sync steps and folder names. Email addresses are removed, and so are passwords ' +
  'and tokens wherever the app recognises them. It ' +
  'never includes your messages, attachments or a copy of the app’s memory.';

const isChoice = (value: unknown): value is CrashReportChoice =>
  value === 'yes' || value === 'no' || value === 'unasked';

const diagnostics = () => (typeof window === 'undefined' ? undefined : window.electronAPI?.diagnostics);

// Bumped by every save, so a read that was already in flight when the user
// answered can't land afterwards and put the stale answer back (which would,
// for one, reopen the consent dialog the user had just answered).
let saves = 0;

/**
 * Read main's answer into the store. Never throws: when it can't be read the
 * store keeps what it had — `null` at boot — so nothing is sent and nothing
 * is asked on a guess.
 */
export async function loadCrashReportChoice(): Promise<CrashReportChoice | null> {
  const before = saves;
  try {
    const res = await diagnostics()?.getCrashReports?.();
    if (res?.success && isChoice(res.data) && saves === before) {
      useCrashReportChoiceStore.setState({ choice: res.data });
    }
  } catch { /* unreadable: keep what we had */ }
  return crashReportChoice();
}

/**
 * Record the user's answer in main. The store follows only once main has
 * saved it, so what the window shows is always what the next launch will do.
 * Resolves to whether it was saved.
 */
export async function saveCrashReportChoice(enabled: boolean): Promise<boolean> {
  saves += 1;
  try {
    const res = await diagnostics()?.setCrashReports?.(enabled);
    if (!res?.success) return false;
    useCrashReportChoiceStore.setState({ choice: enabled ? 'yes' : 'no' });
    return true;
  } catch {
    return false;
  }
}
