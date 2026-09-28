// Entry point for the legal pages (privacy policy, terms). Their text is
// rendered into the HTML at build time (scripts/legal-pages.mjs), so they read
// fine without JavaScript; this only brings in the shared styles and icon.
import './theme.css';
import './styles.css';

import appIconUrl from '../../desktop/public/icon.svg';

import { showAppIcon } from './app-icon.js';

if (typeof window !== 'undefined' && !import.meta.env?.VITEST) showAppIcon(document, appIconUrl);
