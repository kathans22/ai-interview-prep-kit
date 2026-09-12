/**
 * Tabs.jsx — a tab strip that behaves the way a tab strip is supposed to.
 *
 * Decides: which panel is shown, and how the keyboard moves between tabs.
 *
 * Does NOT decide: what is in any panel.
 *
 * IF IT CLAIMS `role="tab"`, IT OWES THE KEYBOARD BEHAVIOUR. Announcing a control as a
 * tab tells a screen reader user that arrow keys move between tabs and that Tab leaves
 * the strip for the panel. A widget that takes the role and leaves each tab in the tab
 * order is worse than plain buttons: it promises a way of moving that does not work, and
 * the user has to discover that by trying. So this implements the pattern:
 *
 *   - ONE tab is in the tab order at a time (`tabIndex` 0 on the selected tab, -1 on the
 *     rest). That is a roving tabindex, and it is what makes Tab jump to the panel
 *     instead of walking every tab.
 *   - Left/Right move between tabs and wrap; Home and End jump to the ends.
 *   - Moving selection moves focus with it, which is the pattern's "automatic
 *     activation" — correct when switching panels is cheap, as it is here.
 *   - `aria-controls` and `aria-labelledby` tie each tab to its panel in both
 *     directions.
 *   - The panel is focusable (`tabIndex={0}`) so Tab from the selected tab lands
 *     somewhere meaningful even when the panel's first element is not focusable.
 */

import { useId, useRef } from 'react';

export default function Tabs({ tabs, active, onChange, className = '' }) {
  const base = useId();
  const refs = useRef([]);

  const index = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === active)
  );

  function select(next) {
    const wrapped = (next + tabs.length) % tabs.length;
    onChange(tabs[wrapped].id);
    // Focus follows selection, so the arrow key that moved it does not leave focus on
    // a tab that is no longer selected.
    refs.current[wrapped]?.focus();
  }

  function handleKeyDown(event) {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        select(index + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        select(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        select(0);
        break;
      case 'End':
        event.preventDefault();
        select(tabs.length - 1);
        break;
      default:
        break;
    }
  }

  const activeTab = tabs[index];

  return (
    <div className={className}>
      <div role="tablist" aria-label="How many roles" className="flex flex-wrap gap-1 border-b border-slate-200">
        {tabs.map((tab, position) => {
          const selected = tab.id === activeTab.id;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                refs.current[position] = node;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.id)}
              onKeyDown={handleKeyDown}
              className={[
                '-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm',
                selected
                  ? 'border-slate-900 font-medium text-slate-900'
                  : 'border-transparent text-slate-600 hover:text-slate-900',
              ].join(' ')}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`${base}-panel-${activeTab.id}`}
        aria-labelledby={`${base}-tab-${activeTab.id}`}
        tabIndex={0}
        className="pt-6"
      >
        {activeTab.panel}
      </div>
    </div>
  );
}
