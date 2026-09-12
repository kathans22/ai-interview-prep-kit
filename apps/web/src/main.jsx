/**
 * main.jsx — browser entry point.
 *
 * Decides: where the React tree mounts, and the order of the providers wrapping it.
 * Routing is driven by the real URL (`BrowserRouter`) rather than a hash, because the
 * server serves one HTML file and a deep link like `/kits/abc` must be a real path the
 * browser can bookmark and reload.
 *
 * Does NOT decide: which URL renders what — that is `App.jsx` — or any application
 * behaviour.
 *
 * THE ORDER IS LOAD-BEARING, outermost first:
 *   BrowserRouter    — everything below it navigates, including the error screen's links
 *                      and the redirect the auth screens perform.
 *   ErrorBoundary    — above the providers, so a crash INSIDE a provider is still caught.
 *                      It is below the router only because it resets on route change,
 *                      which needs the router's location.
 *   ToastProvider    — above anything that might announce something, which is everything.
 *   AuthProvider     — innermost of the providers: it makes a request on mount, and if
 *                      that throws, the boundary above it catches rather than the tree
 *                      failing to mount at all.
 *
 * Providers live here rather than inside `App` so a test can mount `App` under a memory
 * router without fighting a second one.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App.jsx';
import { AuthProvider } from './auth/AuthContext.jsx';
import ErrorBoundary from './ui/ErrorBoundary.jsx';
import { ToastProvider } from './ui/ToastProvider.jsx';
import './index.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('WEB_MOUNT_MISSING: index.html has no #root element to mount into.');
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <ToastProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ToastProvider>
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>
);
