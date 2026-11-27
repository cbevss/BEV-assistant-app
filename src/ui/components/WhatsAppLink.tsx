import { useEffect, useState } from "react";
import { useSettings } from "@/state/settings";
import { linkApi, linked } from "@/lib/whatsappLinked";
import { Field, Toggle, Button } from "./Form";

/** Settings: link WhatsApp as a device (scan a QR code once). */
export function WhatsAppLink() {
  const { settings, update } = useSettings();
  const [qr, setQr] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    const off = linkApi.onEvent((e) => {
      if (e.event === "qr") {
        setQr(e.png);
        setStatus("On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this.");
      } else if (e.event === "qrTimeout") {
        setQr("");
        setStatus("The code ran out. Turn it off and on again for a new one.");
      } else if (e.event === "ready") {
        setQr("");
        setStatus(e.me ? `Linked as +${e.me}. BEV can see and send messages with WhatsApp closed.` : "Linked.");
      } else if (e.event === "loggedOut") {
        setQr("");
        setStatus("Unlinked from your phone.");
        update({ whatsappLinked: false });
      } else if (e.event === "error") {
        setStatus(e.error);
      }
    });
    if (settings.whatsappLinked) linkApi.start().catch((e) => setStatus(String(e)));
    return () => void off.then((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async (on: boolean) => {
    update({ whatsappLinked: on });
    setStatus("");
    if (on) await linkApi.start().catch((e) => setStatus(String(e)));
    else await linkApi.stop();
  };

  return (
    <>
      <Field
        label="Link WhatsApp"
        hint="BEV links to your WhatsApp as a device, like WhatsApp Web, so it can tell you about new messages and send them with WhatsApp closed. This uses an unofficial connection: only turn it on if WhatsApp has allowed it for your account."
      >
        <Toggle checked={!!settings.whatsappLinked} onChange={(v) => void toggle(v)} label="Link WhatsApp" />
      </Field>
      {settings.whatsappLinked && (status || qr) && (
        <div className="flex flex-col items-start gap-3 py-2">
          {status && <p className="text-sm text-ink-2">{status}</p>}
          {qr && <img src={qr} alt="WhatsApp link QR code" className="h-56 w-56 rounded-lg bg-white p-2" />}
          {!qr && status.startsWith("Linked") && (
            <Button
              onClick={() =>
                void linked
                  .logout()
                  .then(() => linkApi.stop())
                  .finally(() => update({ whatsappLinked: false }))
              }
            >
              Unlink
            </Button>
          )}
        </div>
      )}
    </>
  );
}
