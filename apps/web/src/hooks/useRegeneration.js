/**
 * useRegeneration.js — regenerate one section of a kit while the rest stays usable.
 *
 * Decides: the client's side of a regeneration — save what is pending, ask the server,
 * adopt the kit it returns — which target is running, and the last result for each
 * target, so its section can summarise and highlight what changed.
 *
 * Does NOT decide: what is replaced (the server's merge), or how the preview and summary
 * read (`regeneration.js`).
 *
 * THROUGH THE EDITOR, NEVER BESIDE IT. A regeneration and an edit move the same revision.
 * Sent side by side, one of them comes back 409 for no reason the person caused. So a
 * regeneration runs as the editor's exclusive operation: pending edits are saved first,
 * edits made while it runs are drawn at once but held until it returns, and the kit it
 * returns becomes the base they are applied to.
 *
 * ONE AT A TIME. A second regeneration while one runs would conflict on the same
 * revision; the controls say one is running instead of queueing another.
 *
 * FAILURE CHANGES NOTHING. The server leaves the section as it was when generation fails,
 * and says so; that message is shown as it is.
 */

import { useCallback, useState } from 'react';

import { kits } from '../lib/api.js';
import { describeTarget, summariseRegeneration, targetKey } from '../kits/regeneration.js';

export function useRegeneration(kitId, editor, { onError } = {}) {
  const [running, setRunning] = useState(null);
  const [results, setResults] = useState({});
  const [announcement, setAnnouncement] = useState('');

  const run = useCallback(
    async (target) => {
      const key = targetKey(target);
      const { title } = describeTarget(target);
      setRunning(key);
      setAnnouncement(`Regenerating ${title}.`);

      try {
        let before = null;
        const response = await editor.exclusive((base) => {
          before = base;
          return kits.regenerate(kitId, target);
        });

        const summary = summariseRegeneration({ target, report: response.report, before, after: response.kit });
        setResults((current) => ({ ...current, [key]: { target, ...summary } }));
        setAnnouncement(`Finished regenerating ${title}. ${summary.text}`);
      } catch (error) {
        setAnnouncement(`Could not regenerate ${title}.`);
        onError?.(error);
      } finally {
        setRunning(null);
      }
    },
    [kitId, editor, onError]
  );

  const dismiss = useCallback((target) => {
    const key = targetKey(target);
    setResults((current) => {
      const { [key]: _gone, ...rest } = current;
      return rest;
    });
  }, []);

  return {
    running,
    announcement,
    run,
    dismiss,
    isRunning: (target) => running !== null && running === targetKey(target),
    resultFor: (target) => results[targetKey(target)] ?? null,
  };
}
