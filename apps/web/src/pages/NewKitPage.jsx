/**
 * NewKitPage.jsx — start a kit from one posting.
 *
 * Decides: the form, and where a successful submission goes next.
 *
 * Does NOT decide: what a valid posting is (that is `validation.js`, mirroring the
 * server, which remains the authority) or how a kit is built. Creation answers 202 with
 * an id before the work finishes, so this screen's job ends by handing the visitor to the
 * kit's own page, which follows the progress stream.
 *
 * THE BUTTON IS NEVER A DEAD END. A disabled submit with no explanation is the specific
 * failure the brief calls out: the user clicks, nothing happens, and there is nothing on
 * screen saying why. So every reason the form is not submittable is listed beside the
 * button, and the button points at that list with `aria-describedby` — the reasons are
 * part of the button's description, not decoration near it.
 *
 * THE CHARACTER COUNT IS DELIBERATELY NOT IN A LIVE REGION. It changes on every
 * keystroke; announcing it would talk over the person typing, which is worse than
 * silence. It is instead referenced by the textarea's `aria-describedby`, so it is read
 * when the field is reached and on demand. The submittability reasons DO live in a polite
 * region, because those change rarely and are the thing a user is waiting to hear.
 *
 * A DUPLICATE IS NOT AN ERROR. An identical posting submitted twice inside the
 * idempotency window answers 200 with the existing kit rather than queueing a second
 * build, because nothing went wrong and the kit the user asked for already exists. The
 * screen says which and goes there, instead of looking like the button failed.
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import Button from '../ui/Button.jsx';
import Input from '../ui/Input.jsx';
import ErrorState from '../ui/ErrorState.jsx';
import { useToast } from '../ui/ToastProvider.jsx';
import { useCreateKit } from '../hooks/useKits.js';
import { LIMITS, checkKitInput } from '../lib/validation.js';

export default function NewKitPage() {
  const navigate = useNavigate();
  const { show } = useToast();
  const { create, isLoading, error } = useCreateKit();

  const [jd, setJd] = useState('');
  const [companyUrl, setCompanyUrl] = useState('');
  const [days, setDays] = useState('5');

  // Which fields the user has actually visited. An error shown against a field nobody
  // has touched yet reads as the form accusing them of a mistake they have not made;
  // the REASONS list still shows everything, because that is about the button.
  const [touched, setTouched] = useState({});
  const touch = (field) => setTouched((current) => ({ ...current, [field]: true }));

  const check = useMemo(() => checkKitInput({ jd, companyUrl, days }), [jd, companyUrl, days]);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!check.valid || isLoading) return;

    const payload = await create({ jd, company_url: companyUrl.trim(), days: Number(days) }).catch(() => null);
    if (!payload) return; // the hook holds the error; ErrorState below renders it

    if (payload.duplicate) {
      show(payload.message ?? 'You already asked for this one — opening it.', { tone: 'info' });
    }

    navigate(`/kits/${encodeURIComponent(payload.kitId)}`);
  }

  const jdLength = jd.trim().length;

  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">New kit</h1>
      <p className="mt-2 max-w-prose text-sm text-slate-600">
        Paste the job description and, if you have it, the company&apos;s website. The company site is
        optional — without it the kit is built from the posting alone and says so.
      </p>

      <form onSubmit={handleSubmit} noValidate className="mt-6 max-w-2xl space-y-5">
        <Input
          label="Job description"
          textarea
          required
          value={jd}
          onChange={(event) => setJd(event.target.value)}
          onBlur={() => touch('jd')}
          hint={`${jdLength.toLocaleString()} characters — ${LIMITS.jdMin} minimum. Paste the posting as it appears; wording is a signal the extraction reads.`}
          error={touched.jd && !check.fields.jd.valid ? check.fields.jd.reason : undefined}
        />

        <Input
          label="Company website"
          type="url"
          inputMode="url"
          placeholder="https://example.com"
          value={companyUrl}
          onChange={(event) => setCompanyUrl(event.target.value)}
          onBlur={() => touch('companyUrl')}
          hint="Optional. The crawler finds the careers or hiring page itself — no need to link it directly."
          error={touched.companyUrl && !check.fields.companyUrl.valid ? check.fields.companyUrl.reason : undefined}
        />

        <Input
          label="Days until the interview"
          type="number"
          min={LIMITS.daysMin}
          max={LIMITS.daysMax}
          step={1}
          required
          value={days}
          onChange={(event) => setDays(event.target.value)}
          onBlur={() => touch('days')}
          hint={`${LIMITS.daysMin} to ${LIMITS.daysMax}. One day is capped at a single day with nothing dropped; a long run gets real review days.`}
          error={touched.days && !check.fields.days.valid ? check.fields.days.reason : undefined}
          className="max-w-xs"
        />

        {error ? <ErrorState error={error} title="Could not start the kit" /> : null}

        {/* The reasons the button cannot be pressed. Polite, because this changes when a
            field becomes valid — rarely — and it is what the user is waiting to hear. */}
        <div aria-live="polite" id="submit-reasons">
          {check.valid ? null : (
            <ul className="list-inside list-disc space-y-1 text-sm text-slate-600">
              {check.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </div>

        <Button type="submit" disabled={!check.valid || isLoading} aria-describedby="submit-reasons">
          {isLoading ? 'Starting…' : 'Build this kit'}
        </Button>
      </form>
    </section>
  );
}
