/**
 * ErrorState.jsx — a failure, shown in place of the thing that failed.
 *
 * Decides: that the server's own message is what a person reads, and that a retry button
 * appears only when retrying could plausibly help.
 *
 * Does NOT decide: what failed or how to recover. It calls `isRetryable` from the error
 * library rather than inspecting a status itself, because "is this worth retrying" is a
 * property of the error and belongs where the error is defined.
 *
 * THE SERVER'S MESSAGE IS THE MESSAGE. Every API error carries text written to be read —
 * that is a deliberate property of the error contract, not an accident. Replacing it
 * with "Something went wrong" throws away the only sentence that says what to do, and
 * the code is kept visible in small print because it is what makes a support
 * conversation possible.
 */

import { isRetryable } from '../lib/apiError.js';
import Button from './Button.jsx';

export default function ErrorState({ error, onRetry, title = 'That did not work', className = '' }) {
  const canRetry = Boolean(onRetry) && isRetryable(error);

  return (
    <div
      role="alert"
      className={['rounded-lg border border-red-200 bg-red-50 px-4 py-4', className].filter(Boolean).join(' ')}
    >
      <p className="text-sm font-semibold text-red-900">{title}</p>
      <p className="mt-1 text-sm text-red-800">{error?.message ?? 'The request failed.'}</p>

      {error?.code ? <p className="mt-2 font-mono text-xs text-red-700">{error.code}</p> : null}

      {canRetry ? (
        <div className="mt-3">
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
