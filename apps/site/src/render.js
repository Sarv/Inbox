// Turns the view from download-view.js into DOM. Markup and class names are the
// sarv_theme components (.card, .btn, .badge, .banner) unchanged; only layout
// lives in styles.css. Built with createElement, never innerHTML, so nothing
// from the API is ever parsed as markup.
import { ALL_RELEASES_URL, VIEW } from './download-view.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Glyphs traced from sarv_theme's Design System.html reference markup, drawn
// the same way: 24-unit box, currentColor stroke, so they take the button's colour.
const GLYPH = Object.freeze({
  download: 'M12 4v12M6 10l6 6 6-6M4 20h16',
  chevronDown: 'M6 9l6 6 6-6',
});

const icon = (doc, pathData, size, className) => {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  const attrs = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2,
    'aria-hidden': 'true',
    ...(className ? { class: className } : {}),
  };
  Object.entries(attrs).forEach(([name, value]) => svg.setAttribute(name, value));
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', pathData);
  svg.append(path);
  return svg;
};

const element = (doc, tag, { className, text, attrs = {} } = {}, children = []) => {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  Object.entries(attrs).forEach(([name, value]) => node.setAttribute(name, value));
  children.filter(Boolean).forEach((child) => node.append(child));
  return node;
};

/** "262 MB" in the reader's locale. */
export const formatSize = (bytes, locale) =>
  new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'megabyte',
    maximumFractionDigits: 0,
  }).format(bytes / 1_000_000);

/** A UTC ISO timestamp as a date in the reader's locale and time zone. */
export const formatDate = (isoTimestamp, locale) =>
  new Date(isoTimestamp).toLocaleDateString(locale, { dateStyle: 'medium' });

const linkMeta = (link, locale) =>
  [link.detail, link.size ? formatSize(link.size, locale) : null].filter(Boolean).join(' · ');

const downloadButton = (doc, link, className, text, iconSize) =>
  element(doc, 'a', { className, attrs: { href: link.url } }, [
    icon(doc, GLYPH.download, iconSize),
    element(doc, 'span', { text }),
  ]);

const linkRow = (doc, link, locale) =>
  element(doc, 'li', { className: 'download-row' }, [
    element(doc, 'div', { className: 'stack-2 download-row-text' }, [
      element(doc, 'span', { className: 'download-row-label', text: link.label }),
      element(doc, 'span', { className: 'muted text-sm', text: linkMeta(link, locale) }),
    ]),
    downloadButton(doc, link, 'btn btn-secondary btn-sm', 'Download', 14),
  ]);

const releaseLine = (doc, view, locale) =>
  view.version
    ? element(doc, 'div', { className: 'row release-line' }, [
        // .badge capitalises its text, so the version (a lowercase "v") sits beside it.
        element(doc, 'span', { className: 'badge brand', text: 'Latest release' }),
        element(doc, 'span', {
          className: 'text-sm release-version',
          text: `Version ${view.version}`,
        }),
        view.publishedAt
          ? element(doc, 'span', {
              className: 'muted text-sm',
              text: `Released ${formatDate(view.publishedAt, locale)}`,
            })
          : null,
        element(doc, 'a', {
          className: 'text-sm',
          text: 'Release notes',
          attrs: { href: view.notesUrl },
        }),
      ])
    : null;

const heroFor = (doc, view, locale) => {
  if (view.kind === VIEW.DOWNLOAD) {
    return element(doc, 'section', { className: 'stack hero' }, [
      element(doc, 'h1', {
        className: 'hero-title',
        text: `Download Sarv Inbox for ${view.osName}`,
      }),
      element(doc, 'div', { className: 'row' }, [
        downloadButton(
          doc,
          view.primary,
          'btn btn-primary btn-lg',
          `Download for ${view.osName}`,
          18
        ),
      ]),
      element(doc, 'span', {
        className: 'muted text-sm',
        text: [view.primary.label, linkMeta(view.primary, locale)].join(' · '),
      }),
    ]);
  }
  if (view.kind === VIEW.MOBILE) {
    return element(doc, 'section', { className: 'stack hero' }, [
      element(doc, 'h1', { className: 'hero-title', text: 'Sarv Inbox is a desktop app' }),
      element(doc, 'p', {
        className: 'muted',
        text: `There is no ${view.osName} app yet. Open this page on a Mac, Windows or Linux computer to download it.`,
      }),
    ]);
  }
  if (view.kind === VIEW.UNSUPPORTED) {
    return element(doc, 'section', { className: 'stack hero' }, [
      element(doc, 'h1', { className: 'hero-title', text: 'Download Sarv Inbox' }),
      element(doc, 'p', {
        className: 'muted',
        text: `We couldn't match ${view.osName} to an installer. Sarv Inbox runs on macOS, Windows and Linux — pick yours below.`,
      }),
    ]);
  }
  return element(doc, 'section', { className: 'stack hero' }, [
    element(doc, 'h1', { className: 'hero-title', text: `Download Sarv Inbox for ${view.osName}` }),
    element(doc, 'div', { className: 'banner warning' }, [
      element(doc, 'span', {
        text: view.reachedGitHub
          ? `The latest release has no ${view.osName} download.`
          : "Couldn't reach GitHub to find the latest release.",
      }),
    ]),
    element(doc, 'div', { className: 'row' }, [
      element(doc, 'a', {
        className: 'btn btn-primary btn-lg',
        text: 'Open the latest release',
        attrs: { href: view.releasesUrl },
      }),
    ]),
  ]);
};

const alternativesCard = (doc, view, locale) =>
  view.alternatives?.length
    ? element(doc, 'section', { className: 'card card-pad stack' }, [
        element(doc, 'h2', { className: 'section-title', text: `Other ${view.osName} downloads` }),
        element(
          doc,
          'ul',
          { className: 'download-list' },
          view.alternatives.map((link) => linkRow(doc, link, locale))
        ),
      ])
    : null;

const othersCard = (doc, view, locale) =>
  element(doc, 'section', { className: 'card card-pad stack', attrs: { id: 'other-platforms' } }, [
    element(doc, 'h2', {
      className: 'section-title',
      text: view.kind === VIEW.DOWNLOAD ? 'Other platforms' : 'All downloads',
    }),
    ...view.others.map((section) =>
      element(doc, 'div', { className: 'stack-2' }, [
        element(doc, 'h3', { className: 'platform-title', text: section.osName }),
        element(
          doc,
          'ul',
          { className: 'download-list' },
          section.links.map((link) => linkRow(doc, link, locale))
        ),
      ])
    ),
  ]);

const TOGGLE_LABEL = Object.freeze({ false: 'Show other platforms', true: 'Hide other platforms' });

// A visitor who got the right installer rarely needs the others, so the list
// stays out of the page — not even built — until they ask for it.
const othersDisclosure = (doc, view, locale) => {
  const label = element(doc, 'span', { text: TOGGLE_LABEL.false });
  const toggle = element(
    doc,
    'button',
    {
      className: 'btn btn-secondary others-toggle',
      attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'other-platforms' },
    },
    [icon(doc, GLYPH.chevronDown, 14, 'chevron'), label]
  );
  const container = element(doc, 'div', { className: 'stack' }, [
    element(doc, 'div', { className: 'row' }, [toggle]),
  ]);
  toggle.addEventListener('click', () => {
    const card =
      container.querySelector('#other-platforms') ??
      container.appendChild(othersCard(doc, view, locale));
    const expanded = toggle.getAttribute('aria-expanded') !== 'true';
    card.hidden = !expanded;
    toggle.setAttribute('aria-expanded', String(expanded));
    label.textContent = TOGGLE_LABEL[expanded];
  });
  return container;
};

// Where the visitor has no installer of their own, the full list IS the page.
const othersSection = (doc, view, locale) => {
  if (!view.others?.length) return null;
  return view.kind === VIEW.DOWNLOAD
    ? othersDisclosure(doc, view, locale)
    : othersCard(doc, view, locale);
};

const footer = (doc) =>
  element(doc, 'footer', { className: 'row muted text-sm page-footer' }, [
    element(doc, 'a', { text: 'All releases', attrs: { href: ALL_RELEASES_URL } }),
    element(doc, 'span', { text: '·' }),
    element(doc, 'a', {
      text: 'Source on GitHub',
      attrs: { href: 'https://github.com/Sarv/Inbox' },
    }),
  ]);

/** Replaces `root`'s content with the page for `view`. */
export const renderDownloadPage = (root, view, locale) => {
  const doc = root.ownerDocument;
  root.replaceChildren(
    heroFor(doc, view, locale),
    ...[
      releaseLine(doc, view, locale),
      alternativesCard(doc, view, locale),
      othersSection(doc, view, locale),
      footer(doc),
    ].filter(Boolean)
  );
};
