/**
 * ErrorBoundary.jsx — the last line between a render crash and a blank page.
 *
 * Decides: what a visitor sees when a component throws during render, and that the
 * boundary RESETS when the route changes.
 *
 * Does NOT decide: anything about failed requests. Those are values, not throws — they
 * travel as `AppError` through `useAsync` and render as `ErrorState`. This boundary is
 * for the other kind: a bug in our own rendering. Conflating the two would send a 404
 * from the API to the same screen as a null dereference, and they need different words.
 *
 * WHY THE RESET ON NAVIGATION MATTERS. A boundary with no reset latches: it catches one
 * error and then renders its fallback for the rest of the session, so every link the
 * visitor clicks afterwards shows the crash screen and the app appears to be dead when
 * only one screen was. Keying the boundary by pathname means navigating away is a real
 * recovery, which is what a person will try first.
 *
 * WHY A CLASS. `componentDidCatch` and `getDerivedStateFromError` have no hook
 * equivalent — a class here is the API, not a style choice.
 *
 * The message is shown rather than hidden. On the server a 500 never echoes its own text
 * because that text routinely carries paths and credentials, and the client cannot see
 * whether it does. Here the error was produced by code already running in this browser,
 * so there is nothing to leak to this reader that they do not already have — and a
 * crash screen with no detail is unreportable.
 */

import { Component } from 'react';
import { useLocation } from 'react-router-dom';

import { buttonClasses } from './Button.jsx';

class ErrorBoundaryInner extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // The console is the only log this client has. Kept deliberately: without it the
    // component stack — the one piece of information that says WHERE it broke — is lost.
    console.error('[web] render failed', error, info?.componentStack);
  }

  componentDidUpdate(previousProps) {
    // The route changed, so the crashed subtree is gone. Clearing the error lets the new
    // screen render instead of the fallback latching for the rest of the session.
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div role="alert" className="mx-auto max-w-xl px-4 py-16">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">This screen broke</h1>
        <p className="mt-2 text-sm text-slate-600">
          Something in the page failed while rendering. Your data is unaffected — nothing was saved or
          changed by this.
        </p>

        <p className="mt-4 rounded-md border border-slate-200 bg-white p-3 font-mono text-xs text-slate-700">
          {error.message || String(error)}
        </p>

        <div className="mt-6 flex flex-wrap gap-2">
          {/* A real reload, because a reset alone re-renders the same broken tree when
              the cause is state this boundary cannot reach. */}
          <button type="button" onClick={() => window.location.reload()} className={buttonClasses()}>
            Reload the page
          </button>
          <a href="/kits" className={buttonClasses({ variant: 'secondary' })}>
            Go to your kits
          </a>
        </div>
      </div>
    );
  }
}

/**
 * The boundary as used. The wrapper exists only to read the location — a class component
 * cannot call a hook, and the reset needs to know when the route changed.
 */
export default function ErrorBoundary({ children }) {
  const location = useLocation();
  return <ErrorBoundaryInner resetKey={location.pathname}>{children}</ErrorBoundaryInner>;
}
