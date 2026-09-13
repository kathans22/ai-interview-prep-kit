/**
 * CategoryMenu.jsx — move a question to another category without dragging it.
 *
 * Decides: that the choices are the OTHER categories, each a button naming where the
 * question goes; that opening moves focus to the first choice; and that Escape, or a
 * press outside, closes it with focus back on the toggle.
 *
 * Does NOT decide: what moving means or where in the category the question lands. The
 * caller's `onChoose` receives the category.
 *
 * A DISCLOSURE OF BUTTONS, NOT `role="menu"`. The ARIA menu role promises application
 * keyboard behaviour — arrow keys between items, typeahead, Tab leaving the menu — and a
 * menu role without all of it is worse than none, because the screen reader announces a
 * contract the widget then breaks. A toggle with `aria-expanded` and a list of ordinary
 * buttons is fully usable with Tab and Enter and announces nothing it does not do.
 *
 * NOT A NATIVE `<select>`, which would otherwise be the obvious accessible choice. On
 * Windows, Chrome fires `change` as the arrow keys pass over each option of a closed
 * select, so arrowing towards the last category would move the question through every
 * category on the way, sending a request for each.
 *
 * THE LIST OPENS INLINE, NOT AS A POPOVER. An absolutely positioned list near the right
 * edge of a 360px screen overflows it; an inline one just wraps.
 */

import { useEffect, useId, useRef, useState } from 'react';

import { buttonClasses } from '../ui/Button.jsx';

export default function CategoryMenu({ id, options, onChoose, buttonRef }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const wrapper = useRef(null);
  const toggle = useRef(null);
  const firstChoice = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => firstChoice.current?.focus());
    const onPointerDown = (event) => {
      if (!wrapper.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => toggle.current?.focus());
  };

  return (
    <div
      ref={wrapper}
      className={open ? 'w-full' : ''}
      onKeyDown={(event) => {
        if (!open || event.key !== 'Escape') return;
        // Handled here, so an Escape meant for this list does not also close something
        // further out.
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <button
        ref={(node) => {
          toggle.current = node;
          buttonRef?.(node);
        }}
        type="button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Change category, ${id}`}
        onClick={() => (open ? close() : setOpen(true))}
        className={buttonClasses({ variant: 'ghost', size: 'sm' })}
      >
        Change category
      </button>

      {open ? (
        <ul id={listId} className="mt-1 flex flex-wrap gap-1">
          {options.map((option, index) => (
            <li key={option.category}>
              <button
                ref={index === 0 ? firstChoice : undefined}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onChoose(option.category);
                }}
                className={buttonClasses({ variant: 'secondary', size: 'sm' })}
              >
                Move to {option.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
