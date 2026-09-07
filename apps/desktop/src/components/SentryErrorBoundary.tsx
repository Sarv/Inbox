import * as Sentry from '@sentry/electron/renderer';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Top-level React error boundary that reports uncaught render errors to Sentry
 * (with the React component stack attached) and shows a minimal recovery UI.
 *
 * We forward to Sentry's `captureException` directly rather than pulling in
 * `@sentry/react`, whose `ErrorBoundary` would need its bundled `@sentry/core`
 * to match the one inside `@sentry/electron`. The fallback uses inline styles
 * so it still renders when a crash has broken the styled component tree.
 */
export class SentryErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    Sentry.captureException(error, {
      contexts: { react: { componentStack: info.componentStack } },
    });
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          gap: '1rem',
          fontFamily: 'system-ui, sans-serif',
          color: '#e5e7eb',
          background: '#111827',
          padding: '2rem',
          textAlign: 'center',
        }}
      >
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Something went wrong</h1>
        <p style={{ maxWidth: '28rem', color: '#9ca3af' }}>
          Sarv Inbox hit an unexpected error and the crash has been reported. Reloading
          usually recovers.
        </p>
        <button
          type="button"
          onClick={this.handleReload}
          style={{
            padding: '0.5rem 1rem',
            borderRadius: '0.5rem',
            border: 'none',
            background: '#2563eb',
            color: '#fff',
            fontSize: '0.875rem',
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
