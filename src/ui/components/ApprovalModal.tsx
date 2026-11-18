import { ShieldAlert } from "lucide-react";
import { Button } from "./Form";
import { Dialog } from "./Dialog";

/** BEV asks before a sensitive action. Cancel is the default (focused) choice. */
export function ApprovalModal({ description, remaining = 0, onApprove, onCancel }: { description: string; remaining?: number; onApprove: () => void; onCancel: () => void }) {
  return (
    <Dialog
      title="BEV needs your OK"
      tone="accent"
      onClose={onCancel}
      footer={
        <>
          {remaining > 0 && <span className="mr-auto self-center text-xs text-ink-3">{remaining} more waiting</span>}
          <Button variant="ghost" onClick={onCancel} data-autofocus>
            Don't allow
          </Button>
          <Button variant="primary" onClick={onApprove}>
            Allow
          </Button>
        </>
      }
    >
      <div className="flex gap-3">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
        <p className="text-ink">{description}</p>
      </div>
    </Dialog>
  );
}
