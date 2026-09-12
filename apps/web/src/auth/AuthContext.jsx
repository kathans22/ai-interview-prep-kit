/**
 * AuthContext.jsx — who is signed in, for the whole tree.
 *
 * Decides: the four things every screen needs to know or do about identity — the current
 * `user`, whether we are still finding out (`loading`), and the three actions `login`,
 * `register` and `logout`.
 *
 * Does NOT decide: what a valid email or password is, or how a session is represented.
 * The session is an HttpOnly signed cookie, which means this module cannot read it even
 * if it wanted to — the only way to know who is signed in is to ask the server. That is
 * the right shape: a client that could read its own session token could also be made to
 * leak it.
 *
 * WHY `loading` IS A DISTINCT STATE AND NOT `user === null`. On a page refresh the tab
 * knows nothing until `GET /api/auth/me` answers. If "no user yet" and "not signed in"
 * were the same state, every reload would bounce a signed-in person to the sign-in
 * screen for the length of one round trip — and with a slow connection, long enough to
 * click something. Three states, not two: unknown, signed out, signed in.
 *
 * A 401 from that first call is the expected answer for a visitor with no cookie, so it
 * is not an error the UI should show. Any other failure IS surfaced, because "the server
 * is unreachable" and "you are signed out" call for different behaviour from the person
 * reading the screen.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { auth } from '../lib/api.js';
import { isAuthFailure, isCancelled } from '../lib/apiError.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState(null);

  // Ask once, on mount. Every later change to the user goes through the three actions
  // below, so nothing else needs to re-ask.
  useEffect(() => {
    const controller = new AbortController();

    auth
      .me(controller.signal)
      .then((payload) => setUser(payload?.user ?? null))
      .catch((error) => {
        if (isCancelled(error)) return;
        // Not signed in is the normal answer here, not a failure worth reporting.
        if (!isAuthFailure(error)) setBootstrapError(error);
        setUser(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, []);

  const login = useCallback(async (email, password) => {
    const payload = await auth.login(email, password);
    setUser(payload.user);
    return payload.user;
  }, []);

  const register = useCallback(async (email, password) => {
    // Registering signs the person in server-side, so there is no second call to make.
    const payload = await auth.register(email, password);
    setUser(payload.user);
    return payload.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await auth.logout();
    } finally {
      // Signed out locally whatever the server said. A failed logout that left the UI
      // showing a signed-in header would be worse than one that clears optimistically:
      // the cookie is already gone in every case the request actually reached the API,
      // and `api.js` clears the revision ledger either way.
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, bootstrapError, login, register, logout }),
    [user, loading, bootstrapError, login, register, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Read the auth state. Throws when used outside the provider, because the alternative —
 * returning undefined — turns a wiring mistake into a crash three components away.
 */
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('AUTH_CONTEXT_MISSING: useAuth was called outside an AuthProvider.');
  }
  return value;
}
