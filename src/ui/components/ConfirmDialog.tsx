import { motion } from "framer-motion";
import { Button } from "./Form";

/** Generic destructive-action confirmation. */
export function ConfirmDialog({
  text,
  confirmLabel = "Delete",
  onConfirm,
  onCancel,
}: {
  text: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm" role="dialog" aria-modal="true">
      <motion.div initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="glass w-[420px] rounded-2xl p-6">
        <p className="mb-5 text-sm text-slate-200">{text}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} autoFocus>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
