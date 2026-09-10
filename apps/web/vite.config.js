/**
 * vite.config.js — dev server and build configuration for the web client.
 *
 * Decides: how the client is served and bundled, and where API calls are proxied in
 * development so the browser never needs to know the server's port.
 *
 * Does NOT decide: anything the application does. No business logic, no data shaping.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.SERVER_ORIGIN ?? 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
