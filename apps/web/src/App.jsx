/**
 * App.jsx — the route table.
 *
 * Decides: which URL renders which page, and nothing else.
 *
 * Does NOT decide: what a page fetches, whether the visitor may see it, or how the
 * chrome around it looks. Guards arrive with `ProtectedRoute`, chrome with `Layout`,
 * and every byte of data comes from a hook over `api.js`. Keeping this file a table
 * means a new screen is one row here plus one file in `pages/`.
 *
 * The six paths named in the brief are `/login`, `/register`, `/kits`, `/kits/new`,
 * `/kits/:id` and `/kits/:id/practice`. Two more exist for reasons the brief leaves to
 * the implementation: `/` has to resolve to something, and a router with no catch-all
 * renders a blank page for a typo, which is indistinguishable from a crash.
 */

import { Navigate, Route, Routes } from 'react-router-dom';

import LoginPage from './pages/LoginPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import KitsPage from './pages/KitsPage.jsx';
import NewKitPage from './pages/NewKitPage.jsx';
import KitPage from './pages/KitPage.jsx';
import PracticePage from './pages/PracticePage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/kits" replace />} />

      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      <Route path="/kits" element={<KitsPage />} />
      <Route path="/kits/new" element={<NewKitPage />} />
      <Route path="/kits/:id" element={<KitPage />} />
      <Route path="/kits/:id/practice" element={<PracticePage />} />

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
