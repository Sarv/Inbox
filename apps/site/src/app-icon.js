// Shared by the download page (main.js) and the legal pages (legal.js).

const SVG_NS = 'http://www.w3.org/2000/svg';

// The favicon's canvas, and how much of it the round logo fills. The logo's
// outer ring touches its own frame, so a margin keeps it off the disc's edge.
const FAVICON_SIZE = 64;
const LOGO_SCALE = 0.86;

// The icon as an element, without its provenance metadata: that is most of
// the file's bytes and draws nothing.
const parseIcon = (doc, iconSvgText) => {
  const { DOMParser } = doc.defaultView;
  const logo = new DOMParser().parseFromString(iconSvgText, 'image/svg+xml').documentElement;
  logo.querySelectorAll('metadata').forEach((node) => node.remove());
  return logo;
};

const serialize = (doc, node) => new doc.defaultView.XMLSerializer().serializeToString(node);

/**
 * The app icon on a white disc, as SVG markup. Bare, the blue-and-orange ring
 * is lost on a dark browser tab; the disc gives it the same ground everywhere.
 * Built from the desktop icon itself, so there is no second copy of the logo.
 */
export const circledIconSvg = (doc, iconSvgText) => {
  const logo = parseIcon(doc, iconSvgText);
  const logoSize = FAVICON_SIZE * LOGO_SCALE;
  const offset = (FAVICON_SIZE - logoSize) / 2;
  Object.entries({ x: offset, y: offset, width: logoSize, height: logoSize }).forEach(
    ([name, value]) => logo.setAttribute(name, value)
  );

  const favicon = doc.createElementNS(SVG_NS, 'svg');
  favicon.setAttribute('viewBox', `0 0 ${FAVICON_SIZE} ${FAVICON_SIZE}`);
  const disc = doc.createElementNS(SVG_NS, 'circle');
  const radius = FAVICON_SIZE / 2;
  // A favicon is rendered outside the page, so it cannot read a CSS token.
  Object.entries({ cx: radius, cy: radius, r: radius, fill: 'white' }).forEach(([name, value]) =>
    disc.setAttribute(name, value)
  );
  favicon.append(disc, doc.importNode(logo, true));
  return serialize(doc, favicon);
};

const svgDataUrl = (svgText) => `data:image/svg+xml,${encodeURIComponent(svgText)}`;

/**
 * Shows the app icon (the desktop app's icon.svg, as markup) in the header
 * images, and on a white disc as the favicon.
 */
export const showAppIcon = (doc, iconSvgText) => {
  const iconUrl = svgDataUrl(serialize(doc, parseIcon(doc, iconSvgText)));
  doc.querySelectorAll('[data-app-icon]').forEach((image) => image.setAttribute('src', iconUrl));
  const favicon = doc.createElement('link');
  const href = svgDataUrl(circledIconSvg(doc, iconSvgText));
  Object.entries({ rel: 'icon', type: 'image/svg+xml', href }).forEach(([name, value]) =>
    favicon.setAttribute(name, value)
  );
  doc.head.append(favicon);
};
