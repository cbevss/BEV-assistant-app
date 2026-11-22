import { useState } from "react";
import { CreditCard } from "lucide-react";
import { Dialog } from "./Dialog";
import { Button, TextInput } from "./Form";
import { answerPrompt, unlockWith, useCardPrompt } from "@/lib/card";

/** The secret-password pop-up BEV shows before it autofills your card. */
export function CardUnlock() {
  const prompt = useCardPrompt((s) => s.prompt);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (!prompt) return null;

  const close = (ok: boolean) => {
    setPw("");
    setErr("");
    answerPrompt(ok);
  };
  const submit = async () => {
    if (!pw || busy) return;
    setBusy(true);
    try {
      await unlockWith(pw);
      close(true);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
      setPw("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Enter your card password"
      tone="accent"
      onClose={() => close(false)}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!pw}>
            Fill
          </Button>
        </>
      }
    >
      <div className="flex gap-3">
        <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1 space-y-3">
          <p className="text-ink">{prompt.reason}</p>
          <TextInput
            type="password"
            autoComplete="off"
            data-autofocus
            aria-label="Card password"
            placeholder="Secret password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
          />
          {err && <p className="text-xs text-danger">{err}</p>}
          <p className="text-xs text-ink-3">Only fill your card on a checkout you started. If you didn't ask for this, cancel.</p>
        </div>
      </div>
    </Dialog>
  );
}
