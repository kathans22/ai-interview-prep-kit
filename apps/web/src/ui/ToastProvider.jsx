/**
 * ToastProvider.jsx — transient messages, announced rather than merely displayed.
 *
 * Decides: how a short-lived message is queued, how long it stays, and how it reaches a
 * screen reader.
 *
 * Does NOT decide: what deserves one. A toast suits a fact that needs no decision —
 * "Signed out", "Copied". Anything a person must act on belongs in the page, next to the
 * thing it concerns, where it does not vanish after four seconds.
 *
 * THE LIVE REGION MUST EXIST BEFORE THE MESSAGE DOES. A container inserted into the DOM
 * at the same moment as its text is frequently not announced at all: the screen reader
 * has nothing to observe changing. So the region is always rendered and always empty
 * until a toast arrives, which is the difference between an accessible toast and a
 * decorative one.
 *
 * POLITE FOR SUCCESS, ASSERTIVE FOR FAILURE, AND THEY ARE SEPARATE REGIONS. `polite`
 * waits for a pause in what the reader is already saying, which is right for "Signed
 * out" and wrong for a failure. Two regions rather than one with a changing
 * `aria-live` — changing that attribute on a live element has inconsistent results
 * across readers, and a failure that goes unannounced is the one that mattered.
 *
 * Auto-dismissal has a floor of four seconds because a message that disappears before it
 * can be read is the same as no message. A dismiss button is always offered: anything
 * that vanishes on a timer is unreachable to someone reading slowly, and it is a real
 * `<button>`, not a clickable div.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import Button from './Button.jsx';

const ToastContext = createContext(null);

const DEFAULT_DURATION_MS = 5000;
const MIN_DURATION_MS = 4000;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());
  const nextId = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (message, { tone = 'info', duration = DEFAULT_DURATION_MS } = {}) => {
      const id = ++nextId.current;
      setToasts((current) => [...current, { id, message, tone }]);

      const wait = Math.max(duration, MIN_DURATION_MS);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), wait)
      );

      return id;
    },
    [dismiss]
  );

  // Every pending timer is cleared on teardown. A timer firing after unmount calls
  // setState on a dead component, which React no longer warns about — so it would simply
  // stay wrong.
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    []
  );

  const value = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  const failures = toasts.filter((toast) => toast.tone === 'error');
  const others = toasts.filter((toast) => toast.tone !== 'error');

  return (
    <ToastContext.Provider value={value}>
      {children}

      {/* Both regions are always mounted, empty or not. See the header comment. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 px-4 pb-4">
        <div aria-live="assertive" aria-atomic="false" className="flex w-full flex-col items-center gap-2">
          {failures.map((toast) => (
            <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </div>

        <div aria-live="polite" aria-atomic="false" className="flex w-full flex-col items-center gap-2">
          {others.map((toast) => (
            <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

const TONES = Object.freeze({
  info: 'border-slate-300 bg-white text-slate-900',
  success: 'border-green-300 bg-green-50 text-green-900',
  error: 'border-red-300 bg-red-50 text-red-900',
});

function ToastItem({ toast, onDismiss }) {
  return (
    <div
      className={[
        // The container above is click-through so it never blocks the page; each toast
        // takes pointer events back, or its dismiss button would be unclickable.
        'pointer-events-auto flex w-full max-w-md items-start justify-between gap-3 rounded-md border px-3 py-2 shadow-sm',
        TONES[toast.tone] ?? TONES.info,
      ].join(' ')}
    >
      <p className="text-sm">{toast.message}</p>
      <Button variant="ghost" size="sm" onClick={() => onDismiss(toast.id)} aria-label="Dismiss message">
        <span aria-hidden="true">×</span>
      </Button>
    </div>
  );
}

/**
 * Show a toast. Throws outside the provider rather than silently doing nothing — a
 * message that never appears is a bug that hides, and the alternative is a no-op that
 * looks like the feature working.
 */
export function useToast() {
  const value = useContext(ToastContext);
  if (!value) {
    throw new Error('TOAST_CONTEXT_MISSING: useToast was called outside a ToastProvider.');
  }
  return value;
}
