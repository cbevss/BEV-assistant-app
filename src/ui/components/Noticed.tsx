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
      flush
      aside={
        <Button variant="ghost" size="sm" onClick={clear}>
          Clear
        </Button>
      }
    >
      <ul className="divide-y divide-line-subtle">
        {list.map((n) => (
          <li key={n.id} className="px-4 py-2.5 text-sm">
            <span className="tnum mr-2 text-xs text-ink-4">{new Date(n.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>{" "}
            <span className="text-ink">{n.title}.</span> <span className="text-ink-3">{n.body}</span>
            {!n.delivered && <span className="text-warn"> Waiting until your game ends.</span>}
          </li>
        ))}
      </ul>
    </Section>
  );
}
