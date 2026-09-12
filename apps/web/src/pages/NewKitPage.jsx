/**
 * NewKitPage.jsx — skeleton for the create-a-kit screen.
 *
 * Decides: nothing yet. Heading only.
 *
 * Does NOT decide: how long a build takes or how its progress is shown. Creation
 * answers 202 with a kit id before the work finishes, so this screen's job is to hand
 * the visitor to the kit's own page and let that page follow the progress stream.
 */

export default function NewKitPage() {
  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">New kit</h1>
      <p className="mt-2 text-sm text-slate-600">
        Paste a job description and a company URL. The form arrives with the kit hooks.
      </p>
    </section>
  );
}
