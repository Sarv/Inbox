/**
 * Job-title vocabulary, in its own module so both the extractor and the phone
 * scorer can use it without importing each other — they previously formed a
 * cycle (scorer -> extractor for the title check, extractor -> scorer for
 * scoring), which happens to survive bundling but is a trap for the next edit.
 */

const TITLE_KEYWORDS = [
  // C-suite. Kept deliberately broad: a signature line is often JUST the
  // acronym ("CBO"), so an initialism missing from this list means the title is
  // silently dropped — which is exactly how a "CBO" line yielded a null
  // designation while everything else about the contact enriched fine.
  'CEO', 'CTO', 'CFO', 'COO', 'CMO', 'CIO', 'CISO', 'CPO',
  'CBO', 'CRO', 'CHRO', 'CDO', 'CSO', 'CLO', 'CCO', 'CAO', 'CXO', 'CBDO',
  'Managing Director', 'MD', 'General Manager',
  'Founder', 'Co-Founder', 'Co-founder', 'Cofounder',
  'Director', 'Manager', 'Head of', 'VP', 'Vice President',
  'President', 'Engineer', 'Developer', 'Designer', 'Architect',
  'Consultant', 'Analyst', 'Specialist', 'Lead', 'Senior',
  'Principal', 'Junior', 'Associate', 'Partner', 'Owner',
  'Executive', 'Coordinator', 'Supervisor', 'Administrator',
  'Intern', 'President', 'Advocate', 'Counsel',
];

export const TITLE_REGEX = new RegExp(`\\b(${TITLE_KEYWORDS.join('|')})\\b`, 'i');

/** Does this line read like a job-title line? Shared with the phone scorer,
 *  where a title next to a number is evidence of a personal signature block. */
export function looksLikeTitleLine(line: string): boolean {
  const t = (line || '').trim();
  return t.length > 0 && t.length <= 120 && TITLE_REGEX.test(t);
}
