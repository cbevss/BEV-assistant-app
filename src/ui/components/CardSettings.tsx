/** Settings → Privacy → Payment card: save, view (with the secret password) or remove your card. */
import { useEffect, useState } from "react";
import { CreditCard, Eye, Trash2 } from "lucide-react";
import { useSettings } from "@/state/settings";
import { Section, Field, Toggle, Button, TextInput } from "./Form";
import { ConfirmDialog } from "./ConfirmDialog";
import { loadSealed, removeCard, saveCard, unlockWith, validateCard, MIN_PASSWORD, type CardDetails, type SealedCard } from "@/lib/card";

const EMPTY: CardDetails = { number: "", name: "", expiry: "", cvc: "" };
const SHOW_MS = 30_000;

export function CardSettings() {
  const { settings, update } = useSettings();
  const [sealed, setSealed] = useState<SealedCard | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<CardDetails>(EMPTY);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [errs, setErrs] = useState<string[]>([]);
  const [viewPw, setViewPw] = useState("");
  const [shown, setShown] = useState<CardDetails | null>(null);
  const [viewErr, setViewErr] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    loadSealed().then(setSealed).catch(() => setSealed(null));
  }, []);
  // Hide shown details after 30 seconds.
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), SHOW_MS);
    return () => clearTimeout(t);
  }, [shown]);

  const save = async () => {
    const e = validateCard(form);
    if (pw.length < MIN_PASSWORD) e.push(`Use a secret password of at least ${MIN_PASSWORD} characters.`);
    if (pw !== pw2) e.push("The two passwords don't match.");
    setErrs(e);
    if (e.length) return;
    try {
      setSealed(await saveCard(form, pw));
      setForm(EMPTY);
      setPw("");
      setPw2("");
      setAdding(false);
    } catch (x) {
      setErrs([String((x as Error)?.message ?? x)]);
    }
  };

  const view = async () => {
    setViewErr("");
    try {
      setShown(await unlockWith(viewPw));
    } catch (x) {
      setViewErr(String((x as Error)?.message ?? x));
    }
    setViewPw("");
  };

  const set = (k: keyof CardDetails) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <Section title="Payment card">
      <Field
        label="Let BEV autofill my card"
        hint="When you ask BEV to fill in your card on a checkout, it asks for your secret password first, every time. Your card is encrypted on this PC only, never synced, and the AI never sees the number."
      >
        <Toggle label="Card autofill" checked={!!settings.cardAutofill} onChange={(cardAutofill) => update({ cardAutofill })} />
      </Field>

      {sealed && !adding && (
        <Field label={`${sealed.brand} •••• ${sealed.last4}`} hint={shown ? "Hidden again in 30 seconds." : "Enter your secret password to see the full details."}>
          <div className="flex flex-col items-end gap-2">
            {shown ? (
              <div className="space-y-0.5 text-right font-mono text-xs text-ink-2">
                <div>{shown.number.replace(/(\d{4})(?=\d)/g, "$1 ")}</div>
                <div>{shown.name || "No name"} · {shown.expiry}{shown.cvc ? ` · CVC ${shown.cvc}` : ""}</div>
                <Button size="sm" variant="ghost" onClick={() => setShown(null)}>Hide</Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <TextInput type="password" autoComplete="off" placeholder="Secret password" aria-label="Secret password" value={viewPw} onChange={(e) => setViewPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void view()} className="w-40" />
                <Button icon={Eye} onClick={() => void view()} disabled={!viewPw}>View</Button>
              </div>
            )}
            {viewErr && <span className="text-xs text-danger">{viewErr}</span>}
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setAdding(true)}>Replace card</Button>
              <Button size="sm" variant="danger" icon={Trash2} onClick={() => setConfirmRemove(true)}>Remove</Button>
            </div>
          </div>
        </Field>
      )}

      {!sealed && !adding && (
        <Field label="No card saved" hint="Add one to let BEV fill it in for you.">
          <Button icon={CreditCard} onClick={() => setAdding(true)}>Add card</Button>
        </Field>
      )}

      {adding && (
        <Field label={sealed ? "Replace card" : "Add card"} hint="The security code is optional. Leave it blank and you'll type it yourself at checkout.">
          <div className="grid w-full max-w-sm gap-2">
            <TextInput inputMode="numeric" autoComplete="off" placeholder="Card number" aria-label="Card number" value={form.number} onChange={set("number")} />
            <TextInput autoComplete="off" placeholder="Name on card" aria-label="Name on card" value={form.name} onChange={set("name")} />
            <div className="grid grid-cols-2 gap-2">
              <TextInput autoComplete="off" placeholder="MM/YY" aria-label="Expiry" value={form.expiry} onChange={set("expiry")} />
              <TextInput type="password" inputMode="numeric" autoComplete="off" placeholder="CVC (optional)" aria-label="Security code" value={form.cvc} onChange={set("cvc")} />
            </div>
            <TextInput type="password" autoComplete="new-password" placeholder={`Secret password (${MIN_PASSWORD}+ characters)`} aria-label="Secret password" value={pw} onChange={(e) => setPw(e.target.value)} />
            <TextInput type="password" autoComplete="new-password" placeholder="Secret password again" aria-label="Confirm secret password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
            <p className="text-xs text-ink-3">If you forget the password, the card can't be recovered: remove it and add it again.</p>
            {errs.map((e) => (
              <p key={e} className="text-xs text-danger">{e}</p>
            ))}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => { setAdding(false); setForm(EMPTY); setPw(""); setPw2(""); setErrs([]); }}>Cancel</Button>
              <Button variant="primary" onClick={() => void save()}>Save card</Button>
            </div>
          </div>
        </Field>
      )}

      {confirmRemove && (
        <ConfirmDialog
          text="Remove your saved card from BEV?"
          confirmLabel="Remove"
          onCancel={() => setConfirmRemove(false)}
          onConfirm={async () => {
            await removeCard();
            setSealed(null);
            setShown(null);
            setConfirmRemove(false);
          }}
        />
      )}
    </Section>
  );
}
