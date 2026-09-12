/**
 * ConfirmDialog.jsx — "are you sure?", over `Modal`.
 *
 * Decides: that a confirmation names the consequence, and that the confirm button can be
 * disabled while the action it triggers is in flight.
 *
 * Does NOT decide: what the action is, or whether it succeeded. The caller keeps the
 * dialog open on failure and shows the error, because closing it and leaving the failure
 * elsewhere on the page loses the connection between the two.
 *
 * THE CONFIRM LABEL SAYS WHAT HAPPENS. "OK" against a destructive action is the weakest
 * possible wording: it tells someone nothing about what they are agreeing to, and it
 * reads identically whether the dialog deletes one kit or all of them. `confirmLabel`
 * defaults to "Delete" rather than "OK" for that reason, and the caller is expected to
 * be more specific still.
 */

import Button from './Button.jsx';
import Modal from './Modal.jsx';

export default function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  pending = false,
  variant = 'danger',
  children,
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button variant={variant} onClick={onConfirm} disabled={pending}>
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
