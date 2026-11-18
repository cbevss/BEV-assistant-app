import { Button } from "./Form";
import { Dialog } from "./Dialog";

/** Confirmation for actions that can't be undone. */
export function ConfirmDialog({ text, confirmLabel = "Delete", onConfirm, onCancel }: { text: string; confirmLabel?: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Dialog
      title="Are you sure?"
      tone="danger"
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} data-autofocus>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {text}
    </Dialog>
  );
}
