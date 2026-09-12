/**
 * BatchUpload.jsx — several postings from one file.
 *
 * Decides: the upload control, the preview, and when the batch may be sent.
 *
 * Does NOT decide: how a file is parsed (`parseCases.js`) or what a valid case is
 * (`validation.js`, mirroring the server). It also does not decide what happens to a
 * case after submission — the response reports one outcome per case and this screen
 * shows it rather than summarising it away.
 *
 * THE PREVIEW IS THE POINT, NOT THE UPLOAD. A file picker that accepts a file and then
 * reports "3 errors" has told the user almost nothing: they cannot see which row, or
 * what their file actually looked like once parsed. The table shows every row as parsed
 * — including ids this screen supplied for rows that had none — with its own problems
 * beside it. A row that is wrong is wrong visibly and locally.
 *
 * PARTIAL FILES ARE USEFUL. Four good rows and one bad one submit the four. The
 * alternative — refusing the file — makes the user edit and re-upload for a problem the
 * screen has already pinpointed, and the server would have accepted the four anyway.
 *
 * OVERFLOW IS REPORTED, NOT TRIMMED. Rows past the five-case cap are named on screen. A
 * file that silently loses its sixth posting is the kind of bug someone discovers a day
 * later, when the kit they were waiting for was never queued.
 */

import { useId, useState } from 'react';
import { Link } from 'react-router-dom';

import Button from '../ui/Button.jsx';
import Card from '../ui/Card.jsx';
import EmptyState from '../ui/EmptyState.jsx';
import ErrorState from '../ui/ErrorState.jsx';
import { useCreateBatch } from '../hooks/useKits.js';
import { COLUMNS, parseCases, toBatchPayload } from '../lib/parseCases.js';
import { LIMITS } from '../lib/validation.js';

export default function BatchUpload() {
  const fileId = useId();
  const { submit, isLoading, error } = useCreateBatch();

  const [parsed, setParsed] = useState(null);
  const [fileName, setFileName] = useState('');
  const [readError, setReadError] = useState(null);
  const [results, setResults] = useState(null);

  async function handleFile(event) {
    const file = event.target.files?.[0];
    setResults(null);
    setReadError(null);

    if (!file) {
      setParsed(null);
      setFileName('');
      return;
    }

    setFileName(file.name);

    let text;
    try {
      text = await file.text();
    } catch {
      // A file the browser cannot read — removed from disk between picking and reading,
      // or a permissions problem. Rare, and silent if unhandled.
      setParsed(null);
      setReadError('That file could not be read. Try choosing it again.');
      return;
    }

    setParsed(parseCases(text, file.name));
  }

  const rows = parsed?.rows ?? [];
  const validRows = rows.filter((row) => row.valid);
  const payload = toBatchPayload(rows);

  const blockers = [];
  if (!parsed && !readError) blockers.push('Choose a JSON or CSV file first.');
  if (parsed?.fatal) blockers.push(parsed.fatal);
  if (parsed && !parsed.fatal && rows.length === 0) blockers.push('That file parsed, but it contains no rows.');
  if (rows.length > 0 && validRows.length === 0) {
    blockers.push('Every row has a problem — fix at least one and choose the file again.');
  }

  async function handleSubmit() {
    if (payload.length === 0 || isLoading) return;
    const response = await submit(payload).catch(() => null);
    if (response) setResults(response);
  }

  return (
    <div className="space-y-6">
      <div>
        <label htmlFor={fileId} className="block text-sm font-medium text-slate-900">
          File of postings
        </label>
        <p id={`${fileId}-hint`} className="mt-1 max-w-prose text-xs text-slate-600">
          JSON — an array of <code>{'{ id, jd, company_url, days }'}</code> — or CSV with a header row naming{' '}
          {COLUMNS.join(', ')}. Quoted commas and line breaks inside a description are handled, so a spreadsheet
          export works. At most {LIMITS.maxBatchCases} postings per batch.
        </p>
        <input
          id={fileId}
          type="file"
          accept=".json,.csv,application/json,text/csv,text/plain"
          onChange={handleFile}
          aria-describedby={`${fileId}-hint`}
          className="mt-2 block w-full max-w-md text-sm text-slate-700"
        />
      </div>

      {readError ? (
        <p role="alert" className="text-sm text-red-700">
          {readError}
        </p>
      ) : null}

      {parsed?.fatal ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-4">
          <p className="text-sm font-semibold text-red-900">That file could not be used</p>
          <p className="mt-1 text-sm text-red-800">{parsed.fatal}</p>
        </div>
      ) : null}

      {parsed && !parsed.fatal && parsed.overflow > 0 ? (
        <p role="alert" className="text-sm text-amber-800">
          {fileName} has {parsed.overflow} more {parsed.overflow === 1 ? 'posting' : 'postings'} than a batch allows.
          Only the first {LIMITS.maxBatchCases} are shown and will be submitted — the rest are not queued.
        </p>
      ) : null}

      {!parsed && !readError ? (
        <EmptyState
          title="No file chosen yet"
          description="Pick a file and every row appears here, parsed, with anything wrong flagged against the row it came from."
        />
      ) : null}

      {rows.length > 0 ? (
        <Card
          title={`${rows.length} ${rows.length === 1 ? 'row' : 'rows'} parsed from ${fileName} — ${validRows.length} ready`}
          titleAs="h3"
          className="overflow-hidden"
        >
          {/* Its own scroll container: a table is one of the few things allowed to be
              wider than the viewport, and the page itself must never scroll sideways. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <caption className="sr-only">
                Parsed postings, with any problems for each row
              </caption>
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <th scope="col" className="py-2 pe-3">
                    Row
                  </th>
                  <th scope="col" className="py-2 pe-3">
                    Id
                  </th>
                  <th scope="col" className="py-2 pe-3">
                    Days
                  </th>
                  <th scope="col" className="py-2 pe-3">
                    Company
                  </th>
                  <th scope="col" className="py-2 pe-3">
                    Description
                  </th>
                  <th scope="col" className="py-2">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.index}-${row.id}`} className="border-b border-slate-100 align-top">
                    <th scope="row" className="py-2 pe-3 font-normal text-slate-500">
                      {row.index + 1}
                    </th>
                    <td className="py-2 pe-3 font-mono text-xs text-slate-700">{row.id}</td>
                    <td className="py-2 pe-3 text-slate-700">{row.days === '' ? '—' : String(row.days)}</td>
                    <td className="max-w-[12rem] truncate py-2 pe-3 text-slate-700" title={row.companyUrl}>
                      {row.companyUrl || '—'}
                    </td>
                    <td className="max-w-[18rem] py-2 pe-3 text-slate-600">
                      <span className="line-clamp-2 block">{row.jd.trim() || '—'}</span>
                      <span className="text-xs text-slate-400">{row.jd.trim().length.toLocaleString()} chars</span>
                    </td>
                    <td className="py-2">
                      {row.valid ? (
                        <span className="text-green-800">Ready</span>
                      ) : (
                        <ul className="list-inside list-disc space-y-1 text-red-800">
                          {row.problems.map((problem) => (
                            <li key={problem}>{problem}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {error ? <ErrorState error={error} title="The batch was not accepted" /> : null}

      <div aria-live="polite" id="batch-reasons">
        {blockers.length > 0 ? (
          <ul className="list-inside list-disc space-y-1 text-sm text-slate-600">
            {blockers.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <Button
        type="button"
        onClick={handleSubmit}
        disabled={payload.length === 0 || isLoading}
        aria-describedby="batch-reasons"
      >
        {isLoading
          ? 'Queueing…'
          : `Build ${payload.length || ''} ${payload.length === 1 ? 'kit' : 'kits'}`.replace('  ', ' ')}
      </Button>

      {results ? <BatchResults results={results} /> : null}
    </div>
  );
}

/**
 * What the server did with each case.
 *
 * Duplicates are reported rather than hidden: re-uploading the same file is a normal
 * mistake, and "nothing happened" is a worse answer than "these four already exist, here
 * they are".
 */
function BatchResults({ results }) {
  // The envelope key is `kits`, read from the route rather than guessed — an earlier
  // version of this component looked for `results` and rendered a correct summary above
  // an empty list, which is the quietest way for this to be wrong.
  const entries = results.kits ?? [];

  return (
    <Card title="What happened" titleAs="h3">
      <p className="text-sm text-slate-600">
        {results.accepted} queued, {results.duplicates} already existed.
      </p>

      {/* Present only when nothing was queued, and it explains the window rather than
          leaving "0 queued" to look like a failure. */}
      {results.message ? <p className="mt-1 text-sm text-slate-600">{results.message}</p> : null}

      <ul className="mt-3 space-y-2 text-sm">
        {entries.map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-xs text-slate-700">{entry.id}</span>
            <span className="text-slate-600">
              {entry.duplicate ? 'already existed' : 'queued'} — {entry.status}
            </span>
            <Link to={`/kits/${encodeURIComponent(entry.kitId)}`} className="font-medium text-slate-900 underline">
              Open
            </Link>
          </li>
        ))}
      </ul>

      <p className="mt-4 text-sm">
        <Link to="/kits" className="font-medium text-slate-900 underline">
          See all your kits
        </Link>
      </p>
    </Card>
  );
}
