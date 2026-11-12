import { motion } from "framer-motion";

/** Approve / Cancel gate for sensitive tool calls. */
export function ApprovalModal({
  description,
  onApprove,
  onCancel,
}: {
  description: string;
  onApprove: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm">
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="glass w-[420px] rounded-2xl border border-bev-danger/30 p-6"
      >
        <div className="mb-1 text-xs uppercase tracking-widest text-bev-danger">
          Permission required
        </div>
        <p className="mb-5 text-sm text-slate-200">{description}</p>
        <div className="flex justify-end gap-3">
          <button
            className="rounded-lg px-4 py-2 text-sm text-slate-300 hover:bg-white/5"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="rounded-lg bg-bev-cyan/20 px-4 py-2 text-sm font-medium text-bev-cyan shadow-glow hover:bg-bev-cyan/30"
            onClick={onApprove}
          >
            Approve
          </button>
        </div>
      </motion.div>
    </div>
  );
}
