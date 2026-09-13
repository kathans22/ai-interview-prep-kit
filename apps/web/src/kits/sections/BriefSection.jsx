/**
 * BriefSection.jsx — what the company does, as read from its own pages, editable.
 *
 * Decides: how the brief, its provenance and its sources are laid out, and that both
 * text fields can be edited in place.
 *
 * Does NOT decide: whether a brief should exist, or how an edit is saved. The server
 * writes no brief at all when no company pages could be read — deliberately, rather than
 * inventing one from the company's name.
 *
 * AN EMPTY BRIEF STAYS EDITABLE. When nothing could be read, the fields are still shown,
 * with a note saying why they are empty. A person who knows the company can write the
 * brief themselves, and an empty state with no way forward would stop them.
 *
 * WHILE THE BRIEF REGENERATES, ONLY THE BRIEF WAITS. Its own `SectionState` shows the
 * progress; every other section stays usable. Afterwards, a rewritten field is outlined
 * and a summary says which were rewritten and which were kept.
 */

import Card from '../../ui/Card.jsx';
import SectionState from '../../ui/SectionState.jsx';
import EditableText from '../EditableText.jsx';
import RegenerateButton from '../RegenerateButton.jsx';
import RegenerationSummary from '../RegenerationSummary.jsx';
import { deriveSectionState } from '../kitView.js';
import ProvenanceBadges from './ProvenanceBadges.jsx';

const FIELDS = Object.freeze([
  { key: 'summary', label: 'Summary' },
  { key: 'what_they_do', label: 'What they do' },
]);

/** A readable label for a source URL: the path, or the host when the path is bare. */
function sourceLabel(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname && parsed.pathname !== '/' ? `${parsed.host}${parsed.pathname}` : parsed.host;
  } catch {
    return String(url);
  }
}

const TARGET = Object.freeze({ section: 'company_brief' });

export default function BriefSection({ kit, editor, regeneration, onRegenerate, onUndo }) {
  const brief = kit?.company_brief;
  const present = Boolean(brief) && typeof brief === 'object';
  const sources = Array.isArray(brief?.sources) ? brief.sources : [];
  const blank = present && !brief.summary && !brief.what_they_do;
  const busy = regeneration?.isRunning(TARGET) ?? false;
  const result = regeneration?.resultFor(TARGET) ?? null;
  const state = deriveSectionState({ present, busy });

  return (
    <Card
      title="Company brief"
      titleAs="h2"
      actions={
        present ? <RegenerateButton target={TARGET} regeneration={regeneration} onRegenerate={onRegenerate} /> : null
      }
    >
      <RegenerationSummary
        className="mb-4"
        result={busy ? null : result}
        onDismiss={() => regeneration.dismiss(TARGET)}
        onUndo={regeneration?.canUndo(TARGET) ? () => onUndo(TARGET) : null}
      />

      <SectionState
        status={state.status}
        error={state.error}
        loadingLabel={regeneration?.busyLabel(TARGET) ?? 'Regenerating the company brief…'}
      >
        {blank ? (
          <p className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            No company pages could be read, so no brief was written rather than one invented from the company&apos;s
            name. You can write it yourself.
          </p>
        ) : null}

        <dl className="space-y-4">
          {FIELDS.map((field) => {
            const op = { type: 'edit-brief', field: field.key };
            return (
              <div key={field.key}>
                <dt className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                  {field.label}
                  <ProvenanceBadges item={brief?.provenance?.[field.key]} />
                </dt>
                <dd
                  className={`mt-1 ${result?.changed.has(field.key) ? 'rounded-md p-2 ring-2 ring-emerald-400' : ''}`}
                  data-regenerated={result?.changed.has(field.key) ? '' : undefined}
                >
                  <EditableText
                    rows={4}
                    value={brief?.[field.key] ?? ''}
                    label={`${field.label.toLowerCase()} of the company brief`}
                    status={editor.statusOf(op)}
                    onChange={(value) => editor.edit({ ...op, value })}
                    onRevert={(original) => editor.revert(op, original)}
                  >
                    <p className="whitespace-pre-line break-words text-sm text-slate-800">
                      {brief?.[field.key] || <span className="text-slate-500">Nothing recorded.</span>}
                    </p>
                  </EditableText>
                </dd>
              </div>
            );
          })}
        </dl>

        <div className="mt-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Based on {sources.length} {sources.length === 1 ? 'page' : 'pages'} from their site
          </p>
          {sources.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-sm">
              {sources.map((url) => (
                <li key={url} className="truncate">
                  <a href={url} target="_blank" rel="noopener noreferrer" className="text-slate-700 underline">
                    {sourceLabel(url)}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </SectionState>
    </Card>
  );
}
