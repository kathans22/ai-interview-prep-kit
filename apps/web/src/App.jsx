/**
 * App.jsx — the route table, and which routes need an account.
 *
 * Decides: which URL renders which page, and which of them are behind `ProtectedRoute`.
 *
 * Does NOT decide: what a page fetches, or how the chrome around it looks. Guards are
 * declared here rather than inside each page so the answer to "is this screen public?"
 * is readable in one place — a guard buried in a component is one a new screen forgets.
 *
 * The six paths named in the brief are `/login`, `/register`, `/kits`, `/kits/new`,
 * `/kits/:id` and `/kits/:id/practice`. Two more exist for reasons the brief leaves to
 * the implementation: `/` has to resolve to something, and a router with no catch-all
 * renders a blank page for a typo, which is indistinguishable from a crash.
 *
 * The catch-all is deliberately NOT protected. A mistyped URL is not an authentication
 * problem, and guarding it would tell a signed-out visitor their typo was a permissions
 * failure.
 */

import { Navigate, Route, Routes } from 'react-router-dom';

import ProtectedRoute from './auth/ProtectedRoute.jsx';
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

      {/* Public: the two screens a visitor with no account must be able to reach. */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      {/* Behind an account. The server enforces ownership as well — this only saves a
          pointless screen, it is not the security boundary. */}
      <Route
        path="/kits"
        element={
          <ProtectedRoute>
            <KitsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/kits/new"
        element={
          <ProtectedRoute>
            <NewKitPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/kits/:id"
        element={
          <ProtectedRoute>
            <KitPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/kits/:id/practice"
        element={
          <ProtectedRoute>
            <PracticePage />
          </ProtectedRoute>
        }
      />

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
