/**
 * Layout.jsx — the chrome every screen sits inside.
 *
 * Decides: the header, the main container and its width, and where the routed page
 * renders.
 *
 * Does NOT decide: anything about the page itself. It renders an `<Outlet />`, so a new
 * screen inherits the chrome by being a route rather than by remembering to import it —
 * which is the failure mode of a layout that pages wrap themselves in.
 *
 * THE BRAND IS NOT A HEADING. It is a link, deliberately. A layout that renders `<h1>AI
 * Interview Prep Kit</h1>` in the header gives every page two `h1` elements, and the
 * page's own title stops being the document's heading — so a screen reader's heading
 * list reads the product name eight times and never the screen. The page owns its `h1`;
 * the chrome owns none.
 *
 * RESPONSIVE FROM 360px UP. The narrow end is the constraint, not the wide one: the
 * header wraps rather than scrolling sideways, the container's padding never disappears,
 * and no element carries a minimum width that could exceed the viewport. A horizontal
 * scrollbar on a phone is the specific failure this is written to avoid.
 *
 * `#main-content` exists so the skip link added in the styling unit has a target.
 */

import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';

import Button from '../ui/Button.jsx';
import ErrorState from '../ui/ErrorState.jsx';
import { useToast } from '../ui/ToastProvider.jsx';
import { useAuth } from '../auth/AuthContext.jsx';

/** Nav links are only useful to someone who has kits, so they follow the session. */
const NAV = [
  { to: '/kits', label: 'Your kits' },
  { to: '/kits/new', label: 'New kit' },
];

export default function Layout() {
  const { user, loading, logout, bootstrapError } = useAuth();
  const navigate = useNavigate();
  const { show } = useToast();

  async function handleSignOut() {
    await logout();
    navigate('/login', { replace: true });
    // A toast is right here precisely because there is nothing to decide: the header
    // changed and the page moved, and this confirms that was deliberate rather than
    // something going wrong. Announced, not just drawn — see ToastProvider.
    show('You are signed out.', { tone: 'success' });
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* THE FIRST FOCUSABLE THING ON THE PAGE, and it has to be first in the DOM to
          work — a skip link placed after the nav skips nothing. Hidden until focused:
          `sr-only` keeps it available to a screen reader, `focus:not-sr-only` makes it
          visible the moment it is tabbed to, which is the only moment it is useful.

          It exists because the header's links come before the content on every screen,
          so reaching the page itself by keyboard otherwise means tabbing past all of
          them, on every navigation. Its target is `#main-content` on the <main> below. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:border focus:border-slate-300 focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-slate-900"
      >
        Skip to content
      </a>

      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link to="/kits" className="text-sm font-semibold tracking-tight text-slate-900">
            AI Interview Prep Kit
          </Link>

          {/* `nav` needs a name: a page with several navigation landmarks is
              unnavigable if they are all announced as just "navigation". */}
          {user ? (
            <nav aria-label="Main" className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  // `end` so /kits does not stay highlighted while on /kits/new.
                  end
                  className={({ isActive }) =>
                    [
                      'text-sm',
                      isActive ? 'font-medium text-slate-900 underline' : 'text-slate-600 hover:text-slate-900',
                    ].join(' ')
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          ) : null}

          <div className="ms-auto flex flex-wrap items-center gap-x-3 gap-y-1">
            {loading ? null : user ? (
              <>
                {/* The signed-in address, so it is obvious WHICH account this is —
                    the kits of two accounts look identical otherwise. */}
                <span className="max-w-[12rem] truncate text-sm text-slate-600" title={user.email}>
                  {user.email}
                </span>
                <Button variant="secondary" size="sm" onClick={handleSignOut}>
                  Sign out
                </Button>
              </>
            ) : (
              <Link to="/login" className="text-sm font-medium text-slate-900 underline">
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>

      <main id="main-content" className="mx-auto max-w-5xl px-4 py-8">
        {/* The session check failed for a reason that is NOT "you are signed out" —
            the server is unreachable, or answered something unreadable. Shown once here
            rather than on every screen, because the cause is the whole app, not a page.
            A signed-out visitor sees nothing extra: a 401 is the expected answer and is
            not routed here. */}
        {bootstrapError ? (
          <ErrorState
            error={bootstrapError}
            title="Could not check your session"
            onRetry={() => window.location.reload()}
            className="mb-6"
          />
        ) : null}

        <Outlet />
      </main>
    </div>
  );
}
