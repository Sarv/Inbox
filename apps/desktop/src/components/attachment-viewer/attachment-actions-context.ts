import { createContext } from 'react';

import type { AttachmentActions } from './useAttachmentActions';

export const AttachmentActionsContext = createContext<AttachmentActions | undefined>(undefined);
