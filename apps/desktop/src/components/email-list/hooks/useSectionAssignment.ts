import type { ViewFilter } from '@sarvinbox/core';
import { useRef, useEffect, useMemo, useCallback } from 'react';

import type { InboxSection, SectionFilter } from '../../../config/inbox-types';
import { SECTION_FILTER_LABELS } from '../../../config/inbox-types';
import type { EmailThread, SectionData } from '../../../utils/thread-utils';
import { sortThreadsForDisplay, threadStaysVisible } from '../../../utils/thread-utils';
import { getCachedCategorySlugs } from '../CategoryBadges';

interface UseSectionAssignmentParams {
  threads: EmailThread[];
  inboxType: string;
  inboxSections: InboxSection[];
  selectedFolderId: string | null;
  isImportantView: boolean;
  selectedVirtualFolder?: string | null;
  /** Active quick-filter chip ("Filtered: Unread" …), re-checked at render so a
   *  thread that stops matching after an optimistic change leaves the list. */
  viewFilter?: ViewFilter | null;
  /** The open email — its thread is exempt from the quick-filter re-check, so
   *  reading a mail (which auto-marks it read) can't yank the row you're on. */
  selectedEmailId?: string | null;
}

export function useSectionAssignment({
  threads,
  inboxType,
  inboxSections,
  selectedFolderId,
  isImportantView,
  selectedVirtualFolder,
  viewFilter,
  selectedEmailId,
}: UseSectionAssignmentParams) {
  // Stable section assignments — prevents emails from jumping between sections
  // when only read status changes. Recomputes when thread IDs change or star/important changes.
  const sectionAssignmentsRef = useRef<Map<string, string>>(new Map());
  const sectionPropsRef = useRef<Map<string, { starred: boolean; important: boolean; hasUnread: boolean }>>(new Map());

  // Reset stable section assignments when inbox settings change
  useEffect(() => {
    sectionAssignmentsRef.current.clear();
    sectionPropsRef.current.clear();
  }, [inboxType, inboxSections]);

  // Reset stable section assignments when folder changes
  useEffect(() => {
    sectionAssignmentsRef.current.clear();
    sectionPropsRef.current.clear();
  }, [selectedFolderId]);

  // Helper to check if thread matches a filter
  const threadMatchesFilter = useCallback((thread: EmailThread, filter: SectionFilter): boolean => {
    switch (filter) {
      case 'important_unread':
        if (isImportantView) {
          return thread.hasUnread;
        }
        return thread.isImportant && thread.hasUnread;
      case 'important':
        if (isImportantView) {
          return true;
        }
        return thread.isImportant;
      case 'unread':
        return thread.hasUnread;
      case 'starred':
        return thread.isStarred;
      case 'everything_else':
        return true;
      case 'none':
        return false;
      default:
        return false;
    }
  }, [isImportantView]);

  // Split threads into customizable sections
  const sectionedThreads = useMemo((): SectionData[] => {
    // No sections for default inbox, virtual folders, or when no sections configured
    if (inboxType === 'default' || selectedVirtualFolder || inboxSections.length === 0) {
      return [];
    }

    const assignments = sectionAssignmentsRef.current;
    const props = sectionPropsRef.current;
    const categorySlugs = getCachedCategorySlugs();
    const currentIds = new Set(threads.map(t => t.threadId));

    // Remove assignments for threads that no longer exist
    for (const id of assignments.keys()) {
      if (!currentIds.has(id)) {
        assignments.delete(id);
        props.delete(id);
      }
    }

    // Find threads that need (re)assignment:
    // 1. New threads not yet assigned
    // 2. Threads whose starred/important/unread status changed
    const threadsToAssign: EmailThread[] = [];
    for (const thread of threads) {
      if (!assignments.has(thread.threadId)) {
        threadsToAssign.push(thread);
      } else {
        const prev = props.get(thread.threadId);
        if (prev && (prev.starred !== thread.isStarred || prev.important !== thread.isImportant || prev.hasUnread !== thread.hasUnread)) {
          assignments.delete(thread.threadId);
          threadsToAssign.push(thread);
        }
      }
    }

    // Compute assignments for threads that need it
    if (threadsToAssign.length > 0 || assignments.size === 0) {
      const toAssign = assignments.size === 0 ? threads : threadsToAssign;
      const usedIds = new Set<string>();

      for (const section of inboxSections) {
        if (section.filter === 'none' || section.filter === 'everything_else') continue;

        const matches = toAssign.filter(t =>
          !usedIds.has(t.threadId) && threadMatchesFilter(t, section.filter)
        );

        const limited = section.maxItems > 0 ? matches.slice(0, section.maxItems) : matches;
        limited.forEach(t => {
          usedIds.add(t.threadId);
          assignments.set(t.threadId, section.id);
          props.set(t.threadId, { starred: t.isStarred, important: t.isImportant, hasUnread: t.hasUnread });
        });
      }

      // Assign remaining to everything_else
      const everyElse = inboxSections.find(s => s.filter === 'everything_else');
      if (everyElse) {
        toAssign.forEach(t => {
          if (!assignments.has(t.threadId) && !usedIds.has(t.threadId)) {
            assignments.set(t.threadId, everyElse.id);
            props.set(t.threadId, { starred: t.isStarred, important: t.isImportant, hasUnread: t.hasUnread });
          }
        });
      }
    }

    // Build section data using stable assignments
    const result: SectionData[] = [];
    for (const section of inboxSections) {
      if (section.filter === 'none') continue;

      // The active quick-filter is re-checked at render, not just at fetch: the
      // stable assignment above deliberately KEEPS a thread visible when only
      // its read/star state changed (it just re-buckets it), which under
      // "Filtered: Unread" would leave a just-read mail on screen.
      const sectionThreads = sortThreadsForDisplay(
        threads.filter(t => assignments.get(t.threadId) === section.id
          && threadStaysVisible(t, viewFilter, categorySlugs, selectedEmailId))
      );

      if (section.hideWhenEmpty && sectionThreads.length === 0) continue;

      result.push({
        section,
        threads: sectionThreads,
        label: SECTION_FILTER_LABELS[section.filter],
      });
    }

    return result;
  }, [threads, inboxType, inboxSections, selectedVirtualFolder, threadMatchesFilter, viewFilter, selectedEmailId]);

  return { sectionedThreads, threadMatchesFilter };
}
