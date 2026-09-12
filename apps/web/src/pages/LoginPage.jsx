/**
 * LoginPage.jsx — sign in, then go back to wherever the visitor was headed.
 *
 * Decides: where a successful sign-in lands.
 *
 * Does NOT decide: whether the credentials are right. That answer only exists on the
 * server, and the message it returns is the one shown.
 *
 * THE RETURN TRIP IS THE POINT. `ProtectedRoute` records the location it turned someone
 * away from; this screen sends them back to it. Without that, following a link to a
 * specific kit while signed out means signing in and landing on the listing, left to
 * find the kit again — and the link they clicked did nothing.
 *
 * An already-signed-in visitor never sees the form: they get sent on immediately, which
 * also covers the person who reaches for `/login` out of habit.
 */

import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';

import CredentialsForm from '../auth/CredentialsForm.jsx';
import { useAuth } from '../auth/AuthContext.jsx';

export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // Where the guard turned them away from. Search and hash travel too, so a filtered or
  // anchored URL survives the round trip.
  const from = location.state?.from;
  const target = from ? `${from.pathname}${from.search ?? ''}${from.hash ?? ''}` : '/kits';

  if (loading) {
    return (
      <p role="status" className="text-sm text-slate-600">
        Checking your session…
      </p>
    );
  }

  if (user) return <Navigate to={target} replace />;

  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Sign in</h1>
      <p className="mt-2 text-sm text-slate-600">
        {from ? 'Sign in to open that page.' : 'Sign in to see your kits.'}
      </p>

      <CredentialsForm
        submitLabel="Sign in"
        pendingLabel="Signing in…"
        autoCompleteMode="current-password"
        onSubmit={async (email, password) => {
          await login(email, password);
          navigate(target, { replace: true });
        }}
      />

      <p className="mt-6 text-sm text-slate-600">
        No account?{' '}
        <Link to="/register" state={location.state} className="font-medium text-slate-900 underline">
          Create one
        </Link>
        .
      </p>
    </section>
  );
}
