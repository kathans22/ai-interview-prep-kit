/**
 * CredentialsForm.jsx — the email-and-password form, shared by sign-in and register.
 *
 * Decides: the fields, the in-flight state, and that the submit button is disabled while
 * a request is out.
 *
 * Does NOT decide: what happens on submit, or what a valid credential is. The caller
 * passes `onSubmit`; the server owns the rules and returns them as a coded error with a
 * message written to be read. Restating "at least 12 characters" here would put the rule
 * in two places, and the copy in the browser is the one that goes stale.
 *
 * WHY THE TWO SCREENS SHARE THIS. Sign-in and register differ in one function call and
 * two strings. Two copies of a form drift: a `<label>` gets fixed on one and not the
 * other, and the accessibility work ends up silently half-done.
 *
 * The fields and the button are the shared primitives, so the label wiring, the
 * `aria-invalid` handling and the focus treatment are the same here as everywhere else
 * rather than this form's own private version of them.
 */

import { useState } from 'react';

import Button from '../ui/Button.jsx';
import Input from '../ui/Input.jsx';

export default function CredentialsForm({
  submitLabel,
  pendingLabel,
  onSubmit,
  autoCompleteMode = 'current-password',
}) {
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
      <Input
        label="Email"
        name="email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />

      <Input
        label="Password"
        name="password"
        type="password"
        required
        autoComplete={autoCompleteMode}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        // The error is attached to the password field rather than shown loose, so it is
        // announced with the input a person is most likely to correct. The server
        // returns one message for a wrong password and an unknown email on purpose —
        // two different messages would be a free account-enumeration endpoint.
        error={error ? error.message : undefined}
      />

      <Button type="submit" disabled={pending}>
        {pending ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}
