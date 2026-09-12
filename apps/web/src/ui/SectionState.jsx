/**
 * SectionState.jsx — the four states of any region that loads something.
 *
 * Decides: which of `loading`, `empty`, `error` and `ready` a region renders, and that
 * they are handled in that order.
 *
 * Does NOT decide: what "empty" means for a given region. The caller passes `isEmpty`,
 * because an empty list and an empty search result are different sentences even though
 * both are zero rows.
 *
 * WHY A WRAPPER AND NOT FOUR IF-STATEMENTS PER SCREEN. Hand-written branches drift: one
 * screen forgets the empty case and shows a blank panel, another leaves the spinner up
 * after a failure, a third renders its ready state with `data` still null and crashes.
 * Routing every region through one component means all four cases exist everywhere by
 * construction, and the four words here are deliberately the same four `useAsync`
 * reports so nothing has to be translated in between.
 *
 * ORDER MATTERS. `error` is checked before `empty`, because a failed request also has no
 * rows — reversing them reports a failure as "nothing here yet", which tells someone
 * their data is gone when it is merely unreachable.
 */

import { ASYNC_STATES } from '../hooks/useAsync.js';
import ErrorState from './ErrorState.jsx';
import Spinner from './Spinner.jsx';

export default function SectionState({
  status,
  error,
  isEmpty = false,
  onRetry,
  loadingLabel = 'Loading…',
  empty = null,
  children,
}) {
  if (status === ASYNC_STATES.loading || status === ASYNC_STATES.idle) {
    return (
      <div className="py-8">
        <Spinner label={loadingLabel} />
      </div>
    );
  }

  if (status === ASYNC_STATES.error) {
    return <ErrorState error={error} onRetry={onRetry} />;
  }

  if (isEmpty) return empty;

  return children;
}
