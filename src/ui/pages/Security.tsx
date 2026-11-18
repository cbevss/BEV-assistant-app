import { useCallback, useEffect, useState } from "react";
import { native, ActionLogRow } from "@/lib/native";
import { useSettings } from "@/state/settings";
import { useAssistant } from "@/state/assistant";
import { setPrivacy } from "@/voice/bootstrap";
import { allTools, getTool, isSensitive } from "@/ai/tools";
import { PageHeader, Section, Field, Toggle, Button, StatusPill, Segmented } from "../components/Form";
import { ConfirmDialog } from "../components/ConfirmDialog";

export function Security() {
  const { settings, update } = useSettings();
  const { privacyMode } = useAssistant();
  const [log, setLog] = useState<ActionLogRow[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);

  const refresh = useCallback(async () => {
    setLog(await native.actionLogList(100).catch(() => []));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const allToolSpecs = Object.values(allTools()).map((t) => t.spec);

  return (
    <div>
      <PageHeader
        title="Privacy & security"
        subtitle="What BEV may do. Nothing destructive runs without your OK, and you can take any ability away here."
      />

      <Section
        title="Privacy"
        aside={<StatusPill ok={!privacyMode} label={privacyMode ? "mic off" : "mic available"} />}
      >
        <Field label="Privacy mode" hint="Stops all wake-word and microphone processing at once, until you turn it back off.">
          <Toggle label="Privacy mode" checked={privacyMode} onChange={setPrivacy} />
        </Field>
      </Section>

      <Section
        title="Screen replay"
        aside={settings.screenReplay ? <StatusPill ok={!privacyMode} label={privacyMode ? "paused" : "keeping"} /> : undefined}
      >
        <Field
          label="Keep the last few seconds of my screen"
          hint="So you can say “look at the last 20 seconds”. BEV keeps the display your mouse is on, in memory only, and drops it as it ages. Nothing is saved to disk, and frames are only sent to your AI provider when you ask BEV to look back. Paused in privacy mode."
        >
          <Toggle label="Screen replay" checked={settings.screenReplay} onChange={(screenReplay) => update({ screenReplay })} />
        </Field>
        {settings.screenReplay && (
          <Field label="How far back" hint="Longer uses more memory (about 15 MB per minute).">
            <Segmented
              ariaLabel="How far back screen replay keeps"
              value={String(settings.screenReplaySecs)}
              onChange={(v) => update({ screenReplaySecs: Number(v) })}
              options={[15, 30, 60, 120].map((n) => ({ value: String(n), label: n < 60 ? `${n}s` : `${n / 60} min` }))}
            />
          </Field>
        )}
      </Section>

      <Section title="Approvals">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm text-ink">Trust my requests (skip approval prompts)</div>
            <div className="text-xs text-ink-3">
              When on, asking BEV to do something <em>is</em> the approval — sensitive actions like
              closing apps or shutting down run immediately, with no Approve/Cancel prompt. Every
              action is still recorded in the log below. Leave off if you want a confirmation each time.
            </div>
            {settings.autoApproveActions && (
              <div className="mt-2 rounded-md border border-danger/25 bg-danger/10 px-3 py-1.5 text-xs text-danger">
                Approvals are off. BEV will carry out destructive actions the moment you ask.
              </div>
            )}
          </div>
          <Toggle
            label="Trust my requests"
            checked={settings.autoApproveActions}
            onChange={(autoApproveActions) => update({ autoApproveActions })}
          />
        </div>
      </Section>

      <Section title="Tool permissions">
        <p className="text-xs text-ink-3">
          Revoked tools are hidden from BEV entirely — it can't call them by voice or chat.
          {settings.autoApproveActions
            ? " Approval prompts are currently off (see above)."
            : " Tools marked “needs approval” show an Approve/Cancel prompt before running."}
        </p>
        <div className="divide-y divide-line-subtle">
          {allToolSpecs.map((t) => {
            const allowed = settings.toolPermissions[t.name] !== false;
            return (
              <div key={t.name} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-ink">{t.name}</span>
                    {isSensitive(t.name) && (
                      <span className="rounded bg-danger/15 px-1.5 text-[11px] text-danger">
                        needs approval
                      </span>
                    )}
                    {!isSensitive(t.name) && getTool(t.name)?.sensitiveCheck && (
                      <span className="rounded bg-warn/5 px-1.5 text-[11px] text-warn">
                        asks before risky actions
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-ink-3">{t.description}</p>
                </div>
                <Toggle
                  label={`Allow ${t.name}`}
                  checked={allowed}
                  onChange={(v) =>
                    update({ toolPermissions: { ...settings.toolPermissions, [t.name]: v } })
                  }
                />
              </div>
            );
          })}
        </div>
      </Section>

      <Section
        title={`Action log (${log.length})`}
        aside={
          <div className="flex gap-2">
            <Button variant="ghost" onClick={refresh}>
              Refresh
            </Button>
            <Button variant="danger" onClick={() => setConfirmClear(true)} disabled={log.length === 0}>
              Clear
            </Button>
          </div>
        }
      >
        <p className="text-xs text-ink-3">
          A local record of every tool BEV has run. Never leaves this PC.
        </p>
        <ul className="max-h-80 space-y-1 overflow-y-auto font-mono text-xs">
          {log.map((row) => (
            <li key={row.id} className="flex items-start gap-2 py-0.5">
              <span className={row.ok ? "text-ok" : "text-danger"}>{row.ok ? "✓" : "✕"}</span>
              <span className="text-ink-3">{new Date(row.at * 1000).toLocaleTimeString("en-GB")}</span>
              <span className="text-ink-2">{row.tool}</span>
              <span className="truncate text-ink-3">{row.result}</span>
            </li>
          ))}
          {log.length === 0 && <li className="text-ink-3">No actions recorded yet.</li>}
        </ul>
      </Section>

      {confirmClear && (
        <ConfirmDialog
          text="Clear the entire action log? This can't be undone."
          confirmLabel="Clear log"
          onCancel={() => setConfirmClear(false)}
          onConfirm={async () => {
            await native.actionLogClear().catch(() => {});
            setConfirmClear(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}
