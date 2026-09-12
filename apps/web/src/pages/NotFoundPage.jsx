/**
 * NotFoundPage.jsx — the catch-all route.
 *
 * Decides: what an unknown URL renders.
 *
 * Does NOT decide: whether the visitor is signed in. A mistyped path is not an
 * authentication problem, and redirecting it to the sign-in screen would tell a
 * signed-out visitor their typo was a permissions failure.
 *
 * This page is not one of the six the brief names. It exists because a router without a
 * catch-all renders nothing at all for a typo, which on screen is indistinguishable
 * from a crash.
 */

import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Page not found</h1>
      <p className="mt-2 text-sm text-slate-600">
        That URL does not match a screen in this app.
      </p>
      <p className="mt-4 text-sm">
        <Link to="/kits" className="font-medium text-slate-900 underline">
          Go to your kits
        </Link>
      </p>
    </section>
  );
}
