// Real inputs, so the tests break if the real world drifts from them.

// The asset list of v1.2.2 exactly as GitHub returned it (sizes in bytes).
const V122_ASSETS = [
  ['latest-linux-arm64.yml', 699],
  ['latest-linux.yml', 701],
  ['latest-mac.yml', 536],
  ['latest.yml', 349],
  ['sarv-inbox-1.2.2-aarch64.rpm', 97915217],
  ['sarv-inbox-1.2.2-amd64.deb', 120016444],
  ['sarv-inbox-1.2.2-arm64.AppImage', 168167922],
  ['sarv-inbox-1.2.2-arm64.deb', 114054552],
  ['sarv-inbox-1.2.2-mac-arm64-amd64.dmg', 261830599],
  ['sarv-inbox-1.2.2-mac-arm64-amd64.dmg.blockmap', 272900],
  ['sarv-inbox-1.2.2-mac-arm64-amd64.zip', 251683502],
  ['sarv-inbox-1.2.2-mac-arm64-amd64.zip.blockmap', 263792],
  ['sarv-inbox-1.2.2-x86_64.AppImage', 168486926],
  ['sarv-inbox-1.2.2-x86_64.rpm', 103544145],
  ['Sarv.Inbox.Setup.1.2.2.exe', 267437098],
  ['Sarv.Inbox.Setup.1.2.2.exe.blockmap', 280797],
].map(([name, size]) => ({
  name,
  size,
  browser_download_url: `https://github.com/Sarv/Inbox/releases/download/v1.2.2/${name}`,
}));

export const releaseV122 = () => ({
  tag_name: 'v1.2.2',
  html_url: 'https://github.com/Sarv/Inbox/releases/tag/v1.2.2',
  published_at: '2026-09-25T10:16:40Z',
  assets: V122_ASSETS.map((asset) => ({ ...asset })),
});

export const UA = {
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  windowsFirefox:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  linuxX64Firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  linuxArmFirefox: 'Mozilla/5.0 (X11; Linux aarch64; rv:131.0) Gecko/20100101 Firefox/131.0',
  linuxNoArch:
    'Mozilla/5.0 (X11; Linux) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  ubuntuFirefox: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  chromeOs:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  bot: 'curl/8.4.0',
};
