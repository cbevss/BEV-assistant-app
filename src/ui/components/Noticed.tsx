import { useNotices } from "@/proactive/notices";
import { Section, Button } from "./Form";

/** What BEV noticed on its own recently (crashes, network, disk, resources). */
export function Noticed() {
  const { items, clear } = useNotices();
  const list = items.filter((n) => n.kind !== "briefing").slice(0, 8);
  if (!list.length) return null;
  return (
    <Section
      title="BEV noticed"
      aside={
        <Button variant="ghost" onClick={clear}>
          Clear
        </Button>
      }
    >
      <ul className="space-y-2">
        {list.map((n) => (
          <li key={n.id} className="text-sm">
            <span className="tabular-nums text-slate-500">{new Date(n.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>{" "}
            <span className="text-slate-100">{n.title}.</span> <span className="text-slate-400">{n.body}</span>
            {!n.delivered && <span className="text-amber-300"> (waiting until your game ends)</span>}
          </li>
        ))}
      </ul>
    </Section>
  );
}
