/**
 * LoginPage.jsx — skeleton for the sign-in screen.
 *
 * Decides: nothing yet. It renders the page's heading so the route is reachable and the
 * heading order is correct from the first commit.
 *
 * Does NOT decide: how credentials are checked, or where a signed-in visitor goes next.
 * The form arrives with `AuthContext`, and the redirect target is whatever route sent
 * the visitor here — which `ProtectedRoute` remembers rather than this page guessing.
 */

export default function LoginPage() {
  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Sign in</h1>
      <p className="mt-2 text-sm text-slate-600">The sign-in form arrives with the auth context.</p>
    </section>
  );
}
