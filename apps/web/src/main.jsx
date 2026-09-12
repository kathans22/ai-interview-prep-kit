/**
 * main.jsx — browser entry point.
 *
 * Decides: where the React tree mounts, and that routing is driven by the real URL
 * (`BrowserRouter`) rather than a hash. The server serves one HTML file, so a deep link
 * like `/kits/abc` must be a real path the browser can bookmark and reload.
 *
 * Does NOT decide: which URL renders what — that is `App.jsx` — or any application
 * behaviour. The router provider lives here rather than inside `App` so tests can mount
 * `App` under a memory router without fighting a second provider.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import './index.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('WEB_MOUNT_MISSING: index.html has no #root element to mount into.');
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
