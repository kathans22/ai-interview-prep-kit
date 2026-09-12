/**
 * RegisterPage.jsx — skeleton for the create-account screen.
 *
 * Decides: nothing yet. Heading only, so the route is reachable.
 *
 * Does NOT decide: what a valid password is. The server owns that rule and returns it
 * as a coded error; restating it here would create a second copy that drifts.
 */

export default function RegisterPage() {
  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Create an account</h1>
      <p className="mt-2 text-sm text-slate-600">
        Registering signs you in straight away — the server issues the session with the account.
      </p>
    </section>
  );
}
