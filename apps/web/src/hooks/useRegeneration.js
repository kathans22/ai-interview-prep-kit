/**
 * useRegeneration.js — regenerate one section of a kit while the rest stays usable, and
 * take it back.
 *
 * Decides: the client's side of a regeneration and of its undo — save what is pending,
 * ask the server, adopt the kit it returns — which target is running, the last result for
 * each target, and which result can still be undone.
 *
 * Does NOT decide: what is replaced or restored (the server's merge and snapshot), or how
 * the preview, summary and list of later changes read (`regeneration.js`).
 *
 * THROUGH THE EDITOR, NEVER BESIDE IT. A regeneration, an undo and an edit all move the
 * same revision. Sent side by side, one of them comes back 409 for no reason the person
 * caused. So both run as the editor's exclusive operation: pending edits are saved first,
 * edits made meanwhile are drawn at once but held, and the kit that comes back becomes the
 * base they are applied to.
 *
 * ONE AT A TIME. A second regeneration while one runs would conflict on the same
 * revision; the controls say one is running instead of queueing another.
 *
 * ONLY THE LATEST REGENERATION OF A SECTION CAN BE UNDONE. The server keeps one snapshot
 * per section, and every category's questions share the "questions" snapshot: regenerate
 * technical, then behavioural, and the snapshot now holds the kit from between the two.
 * Offering Undo on the technical summary at that point would put back the wrong thing, so
 * the Undo goes from every summary but the section's latest. After an undo the server
 * clears the snapshot, and every summary for that section goes, because what they
 * highlight is no longer there.
 *
 * FAILURE CHANGES NOTHING. The server leaves the section as it was when generation fails,
 * and says so; that message is shown as it is.
 */

import { useCallback, useState } from 'react';

import { kits } from '../lib/api.js';
import { changesSince, describeTarget, summariseRegeneration, targetKey } from '../kits/regeneration.js';

const withoutSection = (map, section, sectionOfKey) =>
  Object.fromEntries(Object.entries(map).filter(([key, value]) => sectionOfKey(key, value) !== section));

export function useRegeneration(kitId, editor, { onError } = {}) {
  const [running, setRunning] = useState(null);
  const [mode, setMode] = useState('regenerate');
  const [results, setResults] = useState({});
  const [latest, setLatest] = useState({}); // server section -> key of the result that can be undone
  const [announcement, setAnnouncement] = useState('');

  const run = useCallback(
    async (target) => {
      const key = targetKey(target);
      const { title } = describeTarget(target);
      setRunning(key);
      setMode('regenerate');
      setAnnouncement(`Regenerating ${title}.`);

      try {
        let before = null;
        const response = await editor.exclusive((base) => {
          before = base;
          return kits.regenerate(kitId, target);
        });

        const summary = summariseRegeneration({ target, report: response.report, before, after: response.kit });
        setResults((current) => ({ ...current, [key]: { target, ...summary, regenerated: response.kit } }));
        setLatest((current) => ({ ...current, [target.section]: key }));
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

  /** Put a section back as it was before its latest regeneration. Resolves to whether it did. */
  const undo = useCallback(
    async (target) => {
      const key = targetKey(target);
      const { title } = describeTarget(target);
      setRunning(key);
      setMode('undo');
      setAnnouncement(`Undoing the regeneration of ${title}.`);

      try {
        await editor.exclusive(() => kits.undoRegenerate(kitId, target.section));
        setResults((current) => withoutSection(current, target.section, (_key, value) => value.target.section));
        setLatest((current) => withoutSection(current, target.section, (section) => section));
        setAnnouncement(`Undone: ${title} ${target.section === 'questions' ? 'are' : 'is'} back as before the regeneration.`);
        return true;
      } catch (error) {
        // The server has nothing to restore — another tab undid it, or regenerated since.
        if (error?.code === 'NOTHING_TO_UNDO') setLatest((current) => withoutSection(current, target.section, (section) => section));
        setAnnouncement(`Could not undo the regeneration of ${title}.`);
        onError?.(error);
        return false;
      } finally {
        setRunning(null);
        setMode('regenerate');
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
    setLatest((current) => (current[target.section] === key ? withoutSection(current, target.section, (s) => s) : current));
  }, []);

  return {
    running,
    announcement,
    run,
    undo,
    dismiss,
    isRunning: (target) => running !== null && running === targetKey(target),
    busyLabel: (target) => (mode === 'undo' ? describeTarget(target).undoing : describeTarget(target).running),
    resultFor: (target) => results[targetKey(target)] ?? null,
    canUndo: (target) => running === null && latest[target.section] === targetKey(target) && Boolean(results[targetKey(target)]),
    /** What an undo of `target` would also throw away, read against the kit on screen. */
    changesSinceFor: (target, currentKit) =>
      changesSince(target.section, results[targetKey(target)]?.regenerated, currentKit),
  };
}
