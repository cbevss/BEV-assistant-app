/** Settings → Privacy → Payment cards: add cards with nicknames, view (with the secret password), rename or remove them. */
import { useEffect, useState } from "react";
import { CreditCard, Eye, Pencil, Trash2 } from "lucide-react";
import { useSettings } from "@/state/settings";
import { Section, Field, Toggle, Button, TextInput } from "./Form";
import { ConfirmDialog } from "./ConfirmDialog";
import { loadCards, removeCard, renameCard, saveCard, unlockWith, validateCard, MIN_PASSWORD, type CardDetails, type SavedCard } from "@/lib/card";

const EMPTY: CardDetails = { number: "", name: "", expiry: "", cvc: "" };
const SHOW_MS = 30_000;
const msg = (e: unknown) => String((e as Error)?.message ?? e);

export function CardSettings() {
  const { settings, update } = useSettings();
  const [cards, setCards] = useState<SavedCard[]>([]);
  /** null: not editing; "new": adding; an id: replacing that card. */
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<CardDetails>(EMPTY);
  const [nickname, setNickname] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [errs, setErrs] = useState<string[]>([]);
  const [viewPw, setViewPw] = useState("");
  const [shown, setShown] = useState<Map<string, CardDetails> | null>(null);
  const [viewErr, setViewErr] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string; err: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<SavedCard | null>(null);

  useEffect(() => {
    loadCards().then(setCards).catch(() => setCards([]));
  }, []);
  // Hide shown details after 30 seconds.
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), SHOW_MS);
    return () => clearTimeout(t);
  }, [shown]);

  const first = cards.length === 0 || (cards.length === 1 && editing === cards[0].id);
  const resetForm = () => {
    setEditing(null);
    setForm(EMPTY);
    setNickname("");
    setPw("");
    setPw2("");
    setErrs([]);
  };

  const save = async () => {
    const e = validateCard(form);
    if (pw.length < MIN_PASSWORD) e.push(`Use a secret password of at least ${MIN_PASSWORD} characters.`);
    if (first && pw !== pw2) e.push("The two passwords don't match.");
    setErrs(e);
    if (e.length) return;
    try {
      setCards(await saveCard(form, nickname, pw, editing && editing !== "new" ? editing : undefined));
      setShown(null);
      resetForm();
    } catch (x) {
      setErrs([msg(x)]);
    }
  };

  const view = async () => {
    setViewErr("");
    try {
      setShown(await unlockWith(viewPw));
    } catch (x) {
      setViewErr(msg(x));
    }
    setViewPw("");
  };

  const set = (k: keyof CardDetails) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <Section title="Payment cards">
      <Field
        label="Let BEV autofill my cards"
        hint="When you ask BEV to fill in a card on a checkout (“use my Monzo card”), it asks for your secret password first, every time. Cards are encrypted on this PC only, never synced, and the AI never sees the numbers."
      >
        <Toggle label="Card autofill" checked={!!settings.cardAutofill} onChange={(cardAutofill) => update({ cardAutofill })} />
      </Field>

      {cards.length > 0 && (
        <Field label="See full details" hint={shown ? "Hidden again in 30 seconds." : "Enter your secret password to show every card's full details below."}>
          <div className="flex flex-col items-end gap-1">
            {shown ? (
              <Button size="sm" variant="ghost" onClick={() => setShown(null)}>
                Hide details
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <TextInput type="password" autoComplete="off" placeholder="Secret password" aria-label="Secret password" value={viewPw} onChange={(e) => setViewPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void view()} className="w-40" />
                <Button icon={Eye} onClick={() => void view()} disabled={!viewPw}>
                  View
                </Button>
              </div>
            )}
            {viewErr && <span className="text-xs text-danger">{viewErr}</span>}
          </div>
        </Field>
      )}

      {cards.map((c) => {
        const d = shown?.get(c.id);
        const isRenaming = renaming?.id === c.id;
        return (
          <Field
            key={c.id}
            label={isRenaming ? "Rename card" : c.nickname}
            hint={isRenaming ? renaming.err || "BEV knows the card by this name." : `${c.brand} •••• ${c.last4}`}
          >
            <div className="flex flex-col items-end gap-2">
              {isRenaming ? (
                <div className="flex items-center gap-2">
                  <TextInput
                    autoFocus
                    aria-label="Nickname"
                    value={renaming.name}
                    onChange={(e) => setRenaming({ ...renaming, name: e.target.value, err: "" })}
                    onKeyDown={(e) => e.key === "Enter" && document.getElementById(`save-${c.id}`)?.click()}
                    className="w-40"
                  />
                  <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                    Cancel
                  </Button>
                  <Button
                    id={`save-${c.id}`}
                    size="sm"
                    variant="primary"
                    onClick={async () => {
                      try {
                        setCards(await renameCard(c.id, renaming.name));
                        setRenaming(null);
                      } catch (x) {
                        setRenaming({ ...renaming, err: msg(x) });
                      }
                    }}
                  >
                    Save
                  </Button>
                </div>
              ) : (
                <>
                  {d && (
                    <div className="space-y-0.5 text-right font-mono text-xs text-ink-2">
                      <div>{d.number.replace(/(\d{4})(?=\d)/g, "$1 ")}</div>
                      <div>
                        {d.name || "No name"} · {d.expiry}
                        {d.cvc ? ` · CVC ${d.cvc}` : ""}
                      </div>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setRenaming({ id: c.id, name: c.nickname, err: "" })}>
                      Rename
                    </Button>
                    <Button size="sm" onClick={() => { resetForm(); setEditing(c.id); setNickname(c.nickname); }}>
                      Replace
                    </Button>
                    <Button size="sm" variant="danger" icon={Trash2} onClick={() => setConfirmRemove(c)}>
                      Remove
                    </Button>
                  </div>
                </>
              )}
            </div>
          </Field>
        );
      })}

      {editing === null && (
        <Field label={cards.length ? "Add another card" : "No cards saved"} hint={cards.length ? "Give each card a nickname so you can tell BEV which to use." : "Add one to let BEV fill it in for you."}>
          <Button icon={CreditCard} onClick={() => { resetForm(); setEditing("new"); }}>
            Add card
          </Button>
        </Field>
      )}

      {editing !== null && (
        <Field
          label={editing === "new" ? "Add card" : "Replace card"}
          hint={first ? "The security code is optional: leave it blank to type it yourself at checkout." : "Enter your existing secret password: all your cards share it. The security code is optional."}
        >
          <div className="grid w-full max-w-sm gap-2">
            <TextInput autoComplete="off" placeholder="Nickname, e.g. Monzo or Work card" aria-label="Nickname" value={nickname} onChange={(e) => setNickname(e.target.value)} />
            <TextInput inputMode="numeric" autoComplete="off" placeholder="Card number" aria-label="Card number" value={form.number} onChange={set("number")} />
            <TextInput autoComplete="off" placeholder="Name on card" aria-label="Name on card" value={form.name} onChange={set("name")} />
            <div className="grid grid-cols-2 gap-2">
              <TextInput autoComplete="off" placeholder="MM/YY" aria-label="Expiry" value={form.expiry} onChange={set("expiry")} />
              <TextInput type="password" inputMode="numeric" autoComplete="off" placeholder="CVC (optional)" aria-label="Security code" value={form.cvc} onChange={set("cvc")} />
            </div>
            <TextInput
              type="password"
              autoComplete={first ? "new-password" : "current-password"}
              placeholder={first ? `Secret password (${MIN_PASSWORD}+ characters)` : "Your secret password"}
              aria-label="Secret password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
            />
            {first && <TextInput type="password" autoComplete="new-password" placeholder="Secret password again" aria-label="Confirm secret password" value={pw2} onChange={(e) => setPw2(e.target.value)} />}
            {first && <p className="text-xs text-ink-3">If you forget the password, your cards can't be recovered: remove them and add them again.</p>}
            {errs.map((e) => (
              <p key={e} className="text-xs text-danger">
                {e}
              </p>
            ))}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={resetForm}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void save()}>
                Save card
              </Button>
            </div>
          </div>
        </Field>
      )}

      {confirmRemove && (
        <ConfirmDialog
          text={`Remove “${confirmRemove.nickname}” (•••• ${confirmRemove.last4}) from BEV?`}
          confirmLabel="Remove"
          onCancel={() => setConfirmRemove(null)}
          onConfirm={async () => {
            setCards(await removeCard(confirmRemove.id));
            setShown(null);
            setConfirmRemove(null);
          }}
        />
      )}
    </Section>
  );
}
