/**
 * useQuestionDrag.js — drag a question by its handle, with a mouse, a pen or a finger.
 *
 * Decides: where a dragged question would land — which category, and before which
 * question — from where the pointer is; and when a drag starts, ends or is abandoned.
 *
 * Does NOT decide: what landing there means. `onDrop` receives the target and
 * `planMove` turns it into operations.
 *
 * POINTER EVENTS, NOT THE HTML DRAG-AND-DROP API. Native drag and drop does not fire for
 * touch in mobile browsers, and the builder has to work at 360px — which is to say on a
 * phone. Pointer events are one code path for mouse, pen and touch. The handle sets
 * `touch-action: none`, so a finger on the handle drags while a finger anywhere else on
 * the row still scrolls the page.
 *
 * THE PAGE SCROLLS ITSELF NEAR THE TOP AND BOTTOM EDGES. A finger that is dragging
 * cannot also scroll, so without this a category further down than one screen could
 * never be reached by touch.
 *
 * THE TARGET IS READ FROM THE DOCUMENT, through data attributes on each category
 * (`data-drop-category`) and each row (`data-question-id`). The question lands before the
 * first row whose middle is below the pointer, so the gaps between rows and the space
 * under a category's last question are targets too, rather than dead zones that make the
 * indicator flicker.
 *
 * ESCAPE ABANDONS A DRAG, and so does the browser cancelling the pointer. Letting go
 * anywhere outside the question bank does nothing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const EDGE_PX = 56;
const MAX_SCROLL_PX = 18;

function targetAt(x, y, draggingId) {
  const element = document.elementFromPoint(x, y);
  const zone = element?.closest?.('[data-drop-category]');
  if (!zone) return null;

  const rows = [...zone.querySelectorAll('[data-question-id]')].filter((row) => row.dataset.questionId !== draggingId);
  const before = rows.find((row) => {
    const box = row.getBoundingClientRect();
    return y < box.top + box.height / 2;
  });

  return { category: zone.dataset.dropCategory, beforeId: before ? before.dataset.questionId : null };
}

const sameTarget = (a, b) => (a?.category ?? null) === (b?.category ?? null) && (a?.beforeId ?? null) === (b?.beforeId ?? null);

export function useQuestionDrag({ onDrop }) {
  const [drag, setDrag] = useState(null); // { id, target } while dragging
  const dragRef = useRef(null);
  const pointer = useRef({ x: 0, y: 0 });
  const frame = useRef(null);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  const update = useCallback((next) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  const retarget = useCallback(() => {
    const current = dragRef.current;
    if (!current) return;
    const target = targetAt(pointer.current.x, pointer.current.y, current.id);
    if (!sameTarget(target, current.target)) update({ ...current, target });
  }, [update]);

  const stop = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = null;
    update(null);
  }, [update]);

  // One animation-frame loop per drag, scrolling faster the closer the pointer is to an
  // edge. Everything under the pointer moves when the page scrolls, so the target is
  // read again after every step.
  const tick = useCallback(() => {
    const { y } = pointer.current;
    const bottomEdge = window.innerHeight - EDGE_PX;
    let delta = 0;
    if (y < EDGE_PX) delta = -Math.min(MAX_SCROLL_PX, Math.ceil(((EDGE_PX - y) / EDGE_PX) * MAX_SCROLL_PX));
    else if (y > bottomEdge) delta = Math.min(MAX_SCROLL_PX, Math.ceil(((y - bottomEdge) / EDGE_PX) * MAX_SCROLL_PX));

    if (delta !== 0) {
      window.scrollBy(0, delta);
      retarget();
    }
    frame.current = requestAnimationFrame(tick);
  }, [retarget]);

  const active = drag !== null;
  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      stop();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, stop]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  /** Spread onto a question's drag handle. */
  const handleProps = (id) => ({
    onPointerDown: (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      // No text selection, and no focus jump, from pressing the handle.
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      pointer.current = { x: event.clientX, y: event.clientY };
      update({ id, target: null });
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(tick);
    },
    onPointerMove: (event) => {
      if (dragRef.current?.id !== id) return;
      pointer.current = { x: event.clientX, y: event.clientY };
      retarget();
    },
    onPointerUp: (event) => {
      if (dragRef.current?.id !== id) return;
      const target = targetAt(event.clientX, event.clientY, id);
      stop();
      if (target) onDropRef.current?.({ id, ...target });
    },
    onPointerCancel: () => {
      if (dragRef.current?.id === id) stop();
    },
  });

  return { draggingId: drag?.id ?? null, target: drag?.target ?? null, handleProps };
}
