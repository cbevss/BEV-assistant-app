/**
 * Sign-in gate. Shown before the app when accounts are switched on and this
 * PC isn't ready yet: sign in with Discord, then either set up encryption
 * (first device) or unlock it (another device). Once a PC is ready it never
 * blocks again, even offline.
 */
import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Check, Minus, X, KeyRound, ShieldCheck } from "lucide-react";
import { useAccount } from "@/account/account";
import { MIN_PASSPHRASE } from "@/account/crypto";
import { Emblem } from "../components/Emblem";
import { Core } from "../components/Core";
import { Button, Notice, TextInput } from "../components/Form";

export function AccountGate({ children }: { children: ReactNode }) {
  const { status, init } = useAccount();
  useEffect(() => {
    void init();
  }, [init]);

  if (status === "off" || status === "ready") return <>{children}</>;
  return (
    <Shell>
      {status === "loading" && <Core state="thinking" size={40} title="Loading your account" />}
      {status === "signedOut" && <SignIn />}
      {status === "setup" && <Setup />}
      {status === "locked" && <Unlock />}
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const w = getCurrentWindow();
  return (
    <div className="flex h-screen w-screen flex-col bg-canvas text-ink">
      <div data-tauri-drag-region className="flex h-[46px] shrink-0 items-center justify-end">
        <button aria-label="Minimise" className="no-drag grid h-full w-[46px] place-items-center text-ink-3 hover:bg-surface-2 hover:text-ink" onClick={() => void w.minimize()}>
          <Minus className="h-4 w-4" />
        </button>
        <button aria-label="Close" className="no-drag grid h-full w-[46px] place-items-center text-ink-3 hover:bg-danger hover:text-white" onClick={() => void w.close()}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="grid flex-1 place-items-center overflow-y-auto px-6 pb-12">{children}</div>
    </div>
  );
}

function ErrorLine() {
  const error = useAccount((a) => a.error);
  return error ? (
    <div className="mt-4 w-full">
      <Notice tone="danger">{error}</Notice>
    </div>
  ) : null;
}

function SignIn() {
  const { signIn, busy } = useAccount();
  return (
    <div className="flex w-full max-w-[420px] flex-col items-center text-center">
      <Emblem state="idle" size={200} />
      <h1 className="mt-6 text-[26px] font-light">Sign in to BEV</h1>
      <p className="mt-2 text-sm text-ink-2">Your account keeps BEV's memories with you on every device. They're encrypted on this PC before they leave it, so nobody else can read them, us included.</p>
      <Button variant="primary" className="mt-7 h-10 w-full" onClick={() => void signIn()} loading={busy}>
        {busy ? "Waiting for Discord in your browser…" : "Sign in with Discord"}
      </Button>
      {busy && <p className="mt-3 text-xs text-ink-3">Finish signing in in your browser, then come back here.</p>}
      <ErrorLine />
    </div>
  );
}

function Setup() {
  const { user, pendingRecoveryKey, startSetup, finishSetup, busy } = useAccount();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  useEffect(() => {
    if (!pendingRecoveryKey) startSetup();
  }, [pendingRecoveryKey, startSetup]);

  const tooShort = pass.length > 0 && pass.length < MIN_PASSPHRASE;
  const mismatch = again.length > 0 && again !== pass;
  const ready = pass.length >= MIN_PASSPHRASE && pass === again;

  return (
    <div className="w-full max-w-[480px]">
      <ShieldCheck className="h-6 w-6 text-accent" aria-hidden />
      <h1 className="mt-4 text-[24px] font-light">Protect your memories{user ? `, ${user.name}` : ""}</h1>

      {!saved ? (
        <>
          <p className="mt-2 text-sm text-ink-2">
            This is your recovery key. It's the only way back in if you forget your passphrase. Save it somewhere safe, like a password manager or on paper. Nobody can reset it for you.
          </p>
          <div className="mt-5 flex items-center gap-3 rounded-lg border border-line bg-surface-1 px-4 py-3">
            <code aria-label={pendingRecoveryKey ?? ""} className="tnum grid flex-1 select-all grid-cols-4 gap-x-3 gap-y-1 font-mono text-[16px] tracking-[0.08em] text-ink">
              {pendingRecoveryKey?.split("-").map((g, i) => (
                <span key={i}>{g}</span>
              ))}
            </code>
            <Button
              size="sm"
              icon={copied ? Check : Copy}
              onClick={async () => {
                if (!pendingRecoveryKey) return;
                await navigator.clipboard.writeText(pendingRecoveryKey);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <Button variant="primary" className="mt-6 h-10 w-full" onClick={() => setSaved(true)}>
            I've saved my recovery key
          </Button>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) void finishSetup(pass);
          }}
        >
          <p className="mt-2 text-sm text-ink-2">Choose a passphrase. You'll type it once on each new device (or in the web version) to unlock your memories. Use a few words that mean something to you.</p>
          <label className="mt-5 block text-sm text-ink-2" htmlFor="pass">Passphrase</label>
          <TextInput id="pass" type="password" autoComplete="new-password" className="mt-1.5 w-full" value={pass} onChange={(e) => setPass(e.target.value)} autoFocus />
          {tooShort && <p className="mt-1 text-xs text-warn">At least {MIN_PASSPHRASE} characters.</p>}
          <label className="mt-4 block text-sm text-ink-2" htmlFor="again">Type it again</label>
          <TextInput id="again" type="password" autoComplete="new-password" className="mt-1.5 w-full" value={again} onChange={(e) => setAgain(e.target.value)} />
          {mismatch && <p className="mt-1 text-xs text-warn">Those don't match.</p>}
          <div className="mt-6 flex gap-2">
            <Button type="button" onClick={() => setSaved(false)}>
              Back
            </Button>
            <Button type="submit" variant="primary" className="flex-1" disabled={!ready} loading={busy}>
              Finish
            </Button>
          </div>
        </form>
      )}
      <ErrorLine />
    </div>
  );
}

function Unlock() {
  const { user, unlock, signOut, busy } = useAccount();
  const [secret, setSecret] = useState("");
  return (
    <form
      className="w-full max-w-[440px]"
      onSubmit={(e) => {
        e.preventDefault();
        if (secret.trim()) void unlock(secret);
      }}
    >
      <KeyRound className="h-6 w-6 text-accent" aria-hidden />
      <h1 className="mt-4 text-[24px] font-light">Unlock your memories</h1>
      <p className="mt-2 text-sm text-ink-2">
        {user ? `Signed in as ${user.name}. ` : ""}Type your passphrase, or your recovery key if you've forgotten it. You only need to do this once on this PC.
      </p>
      <label className="mt-5 block text-sm text-ink-2" htmlFor="secret">Passphrase or recovery key</label>
      <TextInput id="secret" type="password" autoComplete="current-password" className="mt-1.5 w-full" value={secret} onChange={(e) => setSecret(e.target.value)} autoFocus />
      <Button type="submit" variant="primary" className="mt-6 h-10 w-full" disabled={!secret.trim()} loading={busy}>
        Unlock
      </Button>
      <button type="button" className="mt-4 text-sm text-ink-3 underline-offset-2 hover:text-ink hover:underline" onClick={() => void signOut()}>
        Use a different Discord account
      </button>
      <ErrorLine />
    </form>
  );
}
