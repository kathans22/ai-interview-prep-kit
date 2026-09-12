/**
 * CredentialsForm.jsx — the email-and-password form, shared by sign-in and register.
 *
 * Decides: the markup and the in-flight state of the form, and that the submit button is
 * disabled while a request is out.
 *
 * Does NOT decide: what happens on submit, or what a valid credential is. The caller
 * passes `onSubmit`; the server owns the rules and returns them as a coded error with a
 * message written to be read. Restating "at least 12 characters" here would put the rule
 * in two places, and the copy in the browser is the one that goes stale.
 *
 * WHY THE TWO SCREENS SHARE THIS. Sign-in and register differ in one function call and
 * two strings. Two copies of a form drift: a `<label>` gets fixed on one and not the
 * other, and the accessibility work is silently half-done.
 *
 * ACCESSIBILITY IS STRUCTURAL HERE, NOT STYLING. Real `<label htmlFor>` rather than
 * placeholder text, because a placeholder disappears the moment someone types and is not
 * announced as a name. `autoComplete` tokens so a password manager can fill the form.
 * The error is `role="alert"` and tied to the fieldset with `aria-describedby`, so it is
 * announced when it appears rather than sitting silently above a button that "did
 * nothing". Focus rings are added in the styling unit, but nothing here may remove them.
 */

import { useId, useState } from 'react';

export default function CredentialsForm({ submitLabel, pendingLabel, onSubmit, autoCompleteMode = 'current-password' }) {
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(event) {
    event.preventDefault();
    if (pending) return;

    setPending(true);
    setError(null);

    try {
      await onSubmit(email, password);
      // Deliberately no success state: the caller navigates away, and setting state on
      // a component that is about to unmount is how a "leak" warning gets earned.
    } catch (thrown) {
      setError(thrown);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="mt-6 max-w-sm space-y-4">
      <div>
        <label htmlFor={emailId} className="block text-sm font-medium text-slate-900">
          Email
        </label>
        <input
          id={emailId}
          name="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-describedby={error ? errorId : undefined}
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
        />
      </div>

      <div>
        <label htmlFor={passwordId} className="block text-sm font-medium text-slate-900">
          Password
        </label>
        <input
          id={passwordId}
          name="password"
          type="password"
          required
          autoComplete={autoCompleteMode}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-describedby={error ? errorId : undefined}
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
        />
      </div>

      {error ? (
        <p id={errorId} role="alert" className="text-sm text-red-700">
          {error.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {pending ? pendingLabel : submitLabel}
      </button>
    </form>
  );
}
