// Shared by the download page (main.js) and the legal pages (legal.js).

/** Points the header image at the app icon and adds it as the favicon. */
export const showAppIcon = (doc, iconUrl) => {
  doc.querySelectorAll('[data-app-icon]').forEach((image) => image.setAttribute('src', iconUrl));
  const favicon = doc.createElement('link');
  Object.entries({ rel: 'icon', type: 'image/svg+xml', href: iconUrl }).forEach(([name, value]) =>
    favicon.setAttribute(name, value)
  );
  doc.head.append(favicon);
};
