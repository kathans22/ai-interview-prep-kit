/**
 * main.jsx — browser entry point.
 *
 * Decides: where the React tree mounts.
 * Does NOT decide: routing, data fetching or any application behaviour.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('WEB_MOUNT_MISSING: index.html has no #root element to mount into.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
