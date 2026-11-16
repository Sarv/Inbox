import { Archive, Ban, ChevronRight, FileText, Folder, Inbox, Mail, Send, Star, Trash2 } from 'lucide-react';
import type { JSX } from 'react';

import { isStarredFolder, type ClassifiableFolder } from '../config/folder-mapping';

/** A sidebar folder's icon, Gmail style. */
export function FolderIcon({ folder }: { folder: ClassifiableFolder }): JSX.Element {
  const lowerPath = folder.path.toLowerCase();

  // The star goes by the folder's role, the same rule that decides whether
  // opening it lists the starred mail, never by "star" in its name, so a folder
  // called "Startups" or "Restart" doesn't wear it.
  if (isStarredFolder(folder))
    return <Star className="h-4 w-4 text-yellow-500" />;
  if (lowerPath.includes('important'))
    return <ChevronRight className="h-4 w-4 text-yellow-500 fill-yellow-500" />;
  if (lowerPath.includes('all mail'))
    return <Mail className="h-4 w-4" />;

  // Standard folders
  if (lowerPath === 'inbox') return <Inbox className="h-4 w-4" />;
  if (lowerPath.includes('sent')) return <Send className="h-4 w-4" />;
  if (lowerPath.includes('draft')) return <FileText className="h-4 w-4" />;
  if (lowerPath.includes('archive')) return <Archive className="h-4 w-4" />;
  if (lowerPath.includes('trash') || lowerPath.includes('deleted'))
    return <Trash2 className="h-4 w-4" />;
  if (lowerPath.includes('spam') || lowerPath.includes('junk'))
    return <Ban className="h-4 w-4" />;

  // Default folder icon for labels
  return <Folder className="h-4 w-4" />;
}
