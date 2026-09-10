/**
 * App.jsx — the single page of the scaffold.
 *
 * Decides: what the placeholder page looks like, and nothing else.
 * Does NOT decide: how a kit is produced, validated or stored. When real screens
 * arrive they call the API; the logic behind them stays in @aipk/core.
 */

export default function App() {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6 py-16">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
          Scaffold
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-slate-900">
          AI Interview Prep Kit
        </h1>
        <p className="text-base leading-relaxed text-slate-600">
          Paste a job description and a company URL; get back researched requirements,
          questions tied to those requirements, flashcards, and a day-by-day schedule.
        </p>
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
          The client is wired and rendering. Screens arrive in a later stage — this page
          exists to prove React, Vite and Tailwind are working together.
        </div>
      </div>
    </main>
  );
}
