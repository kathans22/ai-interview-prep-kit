/**
 * main.jsx — browser entry point.
 *
 * Decides: where the React tree mounts, and the order of the two providers wrapping it.
 * Routing is driven by the real URL (`BrowserRouter`) rather than a hash, because the
 * server serves one HTML file and a deep link like `/kits/abc` must be a real path the
 * browser can bookmark and reload.
 *
 * Does NOT decide: which URL renders what — that is `App.jsx` — or any application
 * behaviour.
 *
 * THE ORDER MATTERS. `BrowserRouter` is outside `AuthProvider` because the auth screens
 * navigate: sign-in sends a visitor back to the location the guard turned them away
 * from, which needs a router above it. Providers live here rather than inside `App` so a
 * test can mount `App` under a memory router without fighting a second one.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './App.jsx';
import { AuthProvider } from './auth/AuthContext.jsx';
import './index.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('WEB_MOUNT_MISSING: index.html has no #root element to mount into.');
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
