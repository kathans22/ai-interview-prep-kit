/**
 * Card.jsx — a bordered surface with an optional titled header.
 *
 * Decides: the surface. Padding, border, background.
 *
 * Does NOT decide: what heading level its title uses. That is the caller's, via
 * `titleAs`, because heading order is a property of the PAGE and a component that
 * hardcoded `<h2>` would produce an `h1 → h3` jump the moment a card appeared inside a
 * section that already had one. Defaulting to `h2` is right far more often than not,
 * but it stays overridable for exactly that reason.
 */

export default function Card({ title, titleAs: Title = 'h2', actions, className = '', children }) {
  return (
    <section className={['rounded-lg border border-slate-200 bg-white', className].filter(Boolean).join(' ')}>
      {title || actions ? (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          {title ? <Title className="text-sm font-semibold text-slate-900">{title}</Title> : <span />}
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}

      <div className="px-4 py-4">{children}</div>
    </section>
  );
}
