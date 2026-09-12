/**
 * RegisterPage.jsx — create an account, which also signs you in.
 *
 * Decides: where a successful registration lands — the same place sign-in would have,
 * so the return trip survives someone realising mid-flow that they have no account.
 *
 * Does NOT decide: what a valid password is. The server answers that, and its message is
 * what the form shows. The `state` carried on the link from the sign-in screen is what
 * makes the intended destination survive the detour.
 */

import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';

import CredentialsForm from '../auth/CredentialsForm.jsx';
import { useAuth } from '../auth/AuthContext.jsx';

export default function RegisterPage() {
  const { user, loading, register } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

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
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Create an account</h1>
      <p className="mt-2 text-sm text-slate-600">
        Registering signs you in straight away — the server issues the session with the account.
      </p>

      <CredentialsForm
        submitLabel="Create account"
        pendingLabel="Creating your account…"
        autoCompleteMode="new-password"
        onSubmit={async (email, password) => {
          await register(email, password);
          navigate(target, { replace: true });
        }}
      />

      <p className="mt-6 text-sm text-slate-600">
        Already have an account?{' '}
        <Link to="/login" state={location.state} className="font-medium text-slate-900 underline">
          Sign in
        </Link>
        .
      </p>
    </section>
  );
}
