// Shared contact avatar — OFFLINE-FIRST.
//
// The base is deterministic colored INITIALS (from the local name/email), so an
// avatar always renders with ZERO network calls: fully offline, private, and it
// can never show the browser's broken-image icon. This is the single source for
// contact avatars (contacts list, compose recipient chips, …).
//
// A real photo is shown ONLY when a confirmed, locally-cached one is passed in
// via `photoUrl` (a `data:` URI stored on the contact after the user approved
// it — see the confirm-gated avatar flow). It's overlaid on the initials and,
// if it somehow fails to decode, we fall back to the initials. The component
// itself NEVER fetches anything (no gravatar/remote request at render time).
import { useState, useEffect } from 'react';

import { getAvatarColor, getInitials } from './email-detail/utils';

interface AvatarProps {
  email: string;
  /** Display name (any of displayName/name); used for the initials. */
  name?: string | null;
  /** Rendered diameter in pixels. */
  size: number;
  className?: string;
  /** A confirmed, locally-cached photo (a `data:` URI). No network is made. */
  photoUrl?: string | null;
  /** `cover` fills the circle (a photo); `contain` shows the whole image on
   *  white (a brand logo or favicon, which must not be cropped). */
  fit?: 'cover' | 'contain';
  /** Pass-through data attribute naming where the picture came from (tests, styling). */
  'data-avatar-source'?: string;
}

export function Avatar({ email, name, size, className = '', photoUrl, fit = 'cover', 'data-avatar-source': source }: AvatarProps) {
  const [broken, setBroken] = useState(false);
  // A new photo (e.g. list row reused for another contact) is worth another try.
  useEffect(() => { setBroken(false); }, [photoUrl]);

  const safeEmail = email || '';
  const initials = getInitials(name ?? null, safeEmail);
  const color = getAvatarColor(safeEmail);
  const showPhoto = !!photoUrl && !broken;

  return (
    <div
      className={`relative flex-shrink-0 rounded-full overflow-hidden flex items-center justify-center text-white font-medium ${color} ${className}`}
      style={{ width: size, height: size }}
      aria-label={name || safeEmail || undefined}
      title={name || safeEmail || undefined}
      data-avatar-source={source}
    >
      <span style={{ fontSize: Math.max(10, Math.round(size * 0.4)) }}>{initials}</span>
      {showPhoto && (
        <img
          src={photoUrl as string}
          alt=""
          className={fit === 'contain' ? 'absolute inset-0 h-full w-full object-contain bg-white p-[10%]' : 'absolute inset-0 h-full w-full object-cover'}
          onError={() => setBroken(true)}
        />
      )}
    </div>
  );
}
