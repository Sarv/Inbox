// Build the download selector with DOM nodes rather than parsing release data as HTML.
import { LATEST_RELEASE_URL, VIEW } from './download-view.js';
import { OS } from './platform.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DOWNLOAD_PATH = 'M12 4v12M6 10l6 6-6M4 20h16';

const icon = (doc, size) => {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  Object.entries({
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2,
    'aria-hidden': 'true',
  }).forEach(([name, value]) => svg.setAttribute(name, value));
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', DOWNLOAD_PATH);
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

const downloadButton = (doc, link, className, text, size) =>
  element(doc, 'a', { className, attrs: { href: link.url } }, [
    icon(doc, size),
    element(doc, 'span', { text }),
  ]);

const linkRow = (doc, link, locale) =>
  element(doc, 'li', { className: 'download-row' }, [
    element(doc, 'div', { className: 'download-row-text' }, [
      element(doc, 'span', { className: 'download-row-label', text: link.label }),
      element(doc, 'span', { className: 'muted text-sm', text: linkMeta(link, locale) }),
    ]),
    downloadButton(doc, link, 'btn btn-secondary btn-sm', 'Download', 14),
  ]);

const releaseLine = (doc, view, locale) =>
  view.version
    ? element(doc, 'div', { className: 'release-line' }, [
        element(doc, 'span', { className: 'badge brand', text: 'Latest release' }),
        element(doc, 'span', { className: 'release-version', text: 'Version ' + view.version }),
        view.publishedAt
          ? element(doc, 'span', { text: 'Released ' + formatDate(view.publishedAt, locale) })
          : null,
        element(doc, 'a', { text: 'Release notes ↗', attrs: { href: view.notesUrl } }),
      ])
    : null;

const deviceNote = (doc, view) => {
  if (view.kind === VIEW.MOBILE || view.os === OS.IOS || view.os === OS.ANDROID)
    return element(doc, 'p', {
      className: 'download-note',
      text:
        'Sarv Inbox is a desktop app. There is no ' +
        view.osName +
        ' app yet; choose a computer platform below.',
    });
  if (view.kind === VIEW.UNSUPPORTED || view.os === OS.CHROMEOS || view.os === OS.UNKNOWN)
    return element(doc, 'p', {
      className: 'download-note',
      text:
        'We could not identify a desktop installer for ' +
        view.osName +
        '. Choose your computer platform below.',
    });
  return element(doc, 'p', {
    className: 'download-intro',
    text: 'We detected ' + view.osName + '. You can choose another operating system at any time.',
  });
};

const choiceFor = (doc, view, platform, locale) => {
  const choice = element(doc, 'div', {
    className: 'download-choice',
    attrs: { id: 'download-choice' },
  });

  if (platform.primary) {
    choice.append(
      element(doc, 'div', {}, [
        element(doc, 'h3', { text: platform.osName + ' download' }),
        element(doc, 'p', {
          text: platform.primary.label + ' · ' + linkMeta(platform.primary, locale),
        }),
      ]),
      downloadButton(
        doc,
        platform.primary,
        'btn btn-primary btn-lg',
        'Download for ' + platform.osName,
        18
      )
    );
  } else {
    const reason = view.reachedGitHub
      ? 'The latest release has no ' + platform.osName + ' installer.'
      : "Couldn't reach GitHub to find the latest release.";
    choice.append(
      element(doc, 'div', {}, [
        element(doc, 'h3', { text: platform.osName + ' download' }),
        element(doc, 'div', { className: 'banner warning', text: reason }),
      ]),
      element(doc, 'a', {
        className: 'btn btn-primary btn-lg',
        text: 'Open the latest release',
        attrs: { href: view.releasesUrl ?? LATEST_RELEASE_URL },
      })
    );
  }

  const alternatives = platform.alternatives.length
    ? element(doc, 'div', { className: 'download-alt' }, [
        element(doc, 'h4', { text: 'Other ' + platform.osName + ' formats and architectures' }),
        element(
          doc,
          'ul',
          { className: 'download-list' },
          platform.alternatives.map((link) => linkRow(doc, link, locale))
        ),
      ])
    : null;

  return [choice, alternatives].filter(Boolean);
};

const initialOs = (view) =>
  [OS.MAC, OS.WINDOWS, OS.LINUX].includes(view.os)
    ? view.os
    : (view.platforms.find((platform) => platform.primary)?.os ?? OS.MAC);

/** Replaces root's loading state with the latest-release selector. */
export const renderDownloadPage = (root, view, locale) => {
  const doc = root.ownerDocument;
  const selected = initialOs(view);
  const buttons = view.platforms.map((platform) =>
    element(doc, 'button', {
      text: platform.osName,
      attrs: {
        type: 'button',
        'data-os': platform.os,
        'aria-controls': 'download-choice',
        'aria-pressed': String(platform.os === selected),
      },
    })
  );
  const picker = element(
    doc,
    'div',
    { className: 'os-picker', attrs: { role: 'group', 'aria-label': 'Operating system' } },
    buttons
  );
  const selection = element(doc, 'div', { className: 'download-selection' });
  const show = (os) => {
    const platform = view.platforms.find((candidate) => candidate.os === os);
    selection.replaceChildren(...choiceFor(doc, view, platform, locale));
    buttons.forEach((button) =>
      button.setAttribute('aria-pressed', String(button.getAttribute('data-os') === os))
    );
  };
  buttons.forEach((button) =>
    button.addEventListener('click', () => show(button.getAttribute('data-os')))
  );
  root.replaceChildren(deviceNote(doc, view), picker, selection, releaseLine(doc, view, locale));
  show(selected);
};
