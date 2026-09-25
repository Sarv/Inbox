// Logging FIRST: set the renderer log level + install the app.log forwarder
// before any other module has a chance to log, so nothing is missed.
import './bootstrap/renderer-logging';

// MUST be early: restore durable app settings from the core DB into localStorage
// (and install the write-mirror) BEFORE the store/App and any synchronous
// settings reader loads. See the module header for why.
import './bootstrap/app-settings-sync';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { initAppearance } from './appearance';
import { SentryErrorBoundary } from './components/SentryErrorBoundary';
import { initSentryRenderer } from './sentry';
import './index.css';
// The chat view's own stylesheet, then the bridge that repoints its `--sec-*`
// tokens at this app's theme. Order matters: the bridge must win over the
// library's defaults, and both must come after index.css so `--primary` and
// friends are already declared for it to reference.
import '@sarv-in/email-chat-view/style.css';
import './styles/chat-view-theme.css';

// Initialize crash/error reporting before rendering anything.
initSentryRenderer();

// Paint the saved theme/accent/font/density/zoom onto <html> BEFORE the first
// render, or the app shows one frame of the default light theme and then flips.
initAppearance();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SentryErrorBoundary>
      <App />
    </SentryErrorBoundary>
  </StrictMode>
);
