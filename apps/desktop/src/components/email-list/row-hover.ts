// Whether a list row is in its hovered state — pure, so the preference gate is
// tested without mounting a virtualized list of rows.
//
// Hovering is not just decoration here: a hovered row swaps the time,
// attachment clip and category badges for the quick actions (archive, delete,
// snooze…). A reader who turns "Hover actions" off (Appearance -> Layout) is
// asking to keep that metadata visible, so the row must never enter the
// hovered state at all — hiding the actions alone would leave a row that
// blanks its own metadata on every pass of the pointer.

/** True when `threadId` should render its hovered state. */
export const isRowHovered = (
  hoverActionsEnabled: boolean,
  hoveredThreadId: string | null,
  threadId: string,
): boolean => hoverActionsEnabled && hoveredThreadId === threadId;
