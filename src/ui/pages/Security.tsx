import { useCallback, useEffect, useState } from "react";
import { native, ActionLogRow } from "@/lib/native";
import { useSettings } from "@/state/settings";
import { useAssistant } from "@/state/assistant";
import { tools, isSensitive } from "@/ai/tools";
import { PageHeader, Section, Toggle, Button, StatusPill } from "../components/Form";
import { ConfirmDialog } from "../components/ConfirmDialog";

export function Security() {
  const { settings, update } = useSettings();
  const { privacyMode, setPrivacyMode } = useAssistant();
  const [log, setLog] = useState<ActionLogRow[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);

  const refresh = useCallback(async () => {
    setLog(await native.actionLogList(100).catch(() => []));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const allTools = Object.values(tools).map((t) => t.spec);

  return (
    <div>
      <PageHeader
        title="Security & Permissions"
        subtitle="Control exactly what BEV may do. Nothing destructive runs without approval, and you can revoke any capability here."
      />

      <Section
        title="Privacy"
        aside={<StatusPill ok={!privacyMode} label={privacyMode ? "mic off" : "mic available"} />}
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-slate-200">Privacy mode (microphone kill-switch)</div>
            <div className="text-xs text-slate-500">
              Instantly stops all wake-word and microphone processing until you turn it back on.
            </div>
          </div>
          <Toggle label="Privacy mode" checked={privacyMode} onChange={(v) => setPrivacyMode(v)} />
        </div>
      </Section>

      <Section title="Tool permissions">
        <p className="text-xs text-slate-500">
          Revoked tools are hidden from BEV entirely — it can't call them by voice or chat.
          Tools marked “needs approval” always show an Approve/Cancel prompt before running.
        </p>
        <div className="divide-y divide-white/5">
          {allTools.map((t) => {
            const allowed = settings.toolPermissions[t.name] !== false;
            return (
              <div key={t.name} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-slate-200">{t.name}</span>
                    {isSensitive(t.name) && (
                      <span className="rounded bg-bev-danger/15 px-1.5 text-[10px] uppercase tracking-wider text-bev-danger">
                        needs approval
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500">{t.description}</p>
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
        <p className="text-xs text-slate-500">
          A local record of every tool BEV has run. Never leaves this PC.
        </p>
        <ul className="max-h-80 space-y-1 overflow-y-auto font-mono text-xs">
          {log.map((row) => (
            <li key={row.id} className="flex items-start gap-2 py-0.5">
              <span className={row.ok ? "text-bev-ok" : "text-bev-danger"}>{row.ok ? "✓" : "✕"}</span>
              <span className="text-slate-500">{new Date(row.at * 1000).toLocaleTimeString("en-GB")}</span>
              <span className="text-slate-300">{row.tool}</span>
              <span className="truncate text-slate-500">{row.result}</span>
            </li>
          ))}
          {log.length === 0 && <li className="text-slate-500">No actions recorded yet.</li>}
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
