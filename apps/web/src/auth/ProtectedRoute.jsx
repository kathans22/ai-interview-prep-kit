/**
 * ProtectedRoute.jsx — the guard on every screen that needs an account.
 *
 * Decides: whether to render the screen, wait, or send the visitor to sign in — and
 * where they come back to afterwards.
 *
 * Does NOT decide: what any screen contains, or whether the *server* will allow the
 * request. This is a convenience, not a security boundary: the API checks ownership on
 * every call and returns 404 for another account's kit. A guard in the client only
 * prevents a pointless screen, never unauthorised access.
 *
 * THE VISITOR COMES BACK TO WHERE THEY WERE. A guard that redirects to `/login` and then
 * drops everyone on the home screen loses the thing they were trying to reach — which,
 * for a shared link to a specific kit, is the entire point of the URL. The requested
 * location is put in router state on the way out, and the sign-in screen reads it on the
 * way back. `replace` is used so the browser's Back button does not walk into the guard
 * again.
 *
 * WAIT BEFORE REDIRECTING. While `loading` is true nothing is known yet, so a redirect
 * would throw a signed-in person out of their own page on every refresh. The wait is
 * announced with `role="status"`, because a silent blank screen is indistinguishable
 * from a broken one to anyone using a screen reader.
 */

import { Navigate, useLocation } from 'react-router-dom';

import Spinner from '../ui/Spinner.jsx';
import { useAuth } from './AuthContext.jsx';

export default function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <Spinner label="Checking your session…" />;
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return children;
}
