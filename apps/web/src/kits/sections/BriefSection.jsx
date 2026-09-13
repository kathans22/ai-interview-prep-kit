/**
 * BriefSection.jsx — what the company does, as read from its own pages.
 *
 * Decides: how the brief, its provenance and its sources are laid out.
 *
 * Does NOT decide: whether a brief should exist. The server writes none at all when no
 * company pages could be read — deliberately, rather than inventing one from the
 * company's name — so an empty brief here is an honest outcome and is rendered as one.
 */

import Card from '../../ui/Card.jsx';
import EmptyState from '../../ui/EmptyState.jsx';
import SectionState from '../../ui/SectionState.jsx';
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

export default function BriefSection({ kit }) {
  const brief = kit?.company_brief;
  const present = Boolean(brief) && typeof brief === 'object';
  const sources = Array.isArray(brief?.sources) ? brief.sources : [];
  const state = deriveSectionState({
    present,
    isEmpty: present && !brief.summary && !brief.what_they_do,
  });

  return (
    <Card title="Company brief" titleAs="h2">
      <SectionState
        status={state.status}
        error={state.error}
        isEmpty={state.isEmpty}
        loadingLabel="Regenerating the company brief…"
        empty={
          <EmptyState
            title="No brief was written"
            description="No company pages could be read, so the brief was left empty rather than invented from the company's name."
          />
        }
      >
        <dl className="space-y-4">
          {FIELDS.map((field) => (
            <div key={field.key}>
              <dt className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                {field.label}
                <ProvenanceBadges item={brief?.provenance?.[field.key]} />
              </dt>
              <dd className="mt-1 whitespace-pre-line break-words text-sm text-slate-800">
                {brief?.[field.key] || <span className="text-slate-500">Nothing recorded.</span>}
              </dd>
            </div>
          ))}
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
