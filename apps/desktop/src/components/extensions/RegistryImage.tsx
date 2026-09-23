import { registryMirrorUrl } from '@sarvinbox/core/registry-mirror';
import { useState, type ImgHTMLAttributes } from 'react';


/**
 * An icon or screenshot served by the registry, fetched from the CDN mirror
 * first and from the canonical host if that fails.
 *
 * Same rule as the registry documents in the main process, for the same reason:
 * `raw.githubusercontent.com` has no edge in much of the world, and a panel
 * full of icons that each take seconds reads as a broken panel. The URL in the
 * registry stays canonical — it is what the host allowlist was checked against
 * when the document was parsed — and only the request is redirected.
 *
 * `onUnavailable` fires once BOTH have failed, so a caller that hides broken
 * pictures does not hide one the canonical host would have served.
 */
interface RegistryImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError'> {
  src: string;
  /** Called when neither the mirror nor the canonical URL could load the image. */
  onUnavailable?: () => void;
}

export function RegistryImage({ src, onUnavailable, ...rest }: RegistryImageProps) {
  // Keyed by the URL it fell back FROM, so a component reused for a different
  // extension starts again at the mirror instead of inheriting a stale retry.
  const [fellBackFrom, setFellBackFrom] = useState<string | null>(null);
  const mirror = fellBackFrom === src ? null : registryMirrorUrl(src);

  return (
    <img
      {...rest}
      src={mirror ?? src}
      onError={() => {
        if (mirror) {
          setFellBackFrom(src);
          return;
        }
        onUnavailable?.();
      }}
    />
  );
}
