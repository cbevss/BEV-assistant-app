/**
 * Lists ("add milk to my shopping list", "what's on my to-do list?"),
 * stored as BEV notes tagged "list" so they show in Memory → Notes and sync
 * with the account like other notes. One "- item" per line; done items are
 * removed.
 */
import { native } from "./native";
import { saveNote, deleteNote } from "@/brain/memory";

// ---------------------------------------------------------------------------
// Pure (tested)

/** "shopping", "my shopping list", "Shopping List" → "Shopping list" */
export function listTitle(name: string): string {
  const n = name.trim().replace(/^(my|the)\s+/i, "").replace(/\s+list$/i, "").trim() || "To-do";
  return `${n.charAt(0).toUpperCase()}${n.slice(1).toLowerCase()} list`;
}

export const parseItems = (body: string) =>
  body
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\[[ x]\]|\d+[.)])\s*/i, "").trim())
    .filter(Boolean);

export const formatItems = (items: string[]) => items.map((i) => `- ${i}`).join("\n");

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/** Add items, skipping ones already there (any case). */
export function addItems(current: string[], add: string[]): { items: string[]; added: string[] } {
  const have = new Set(current.map(norm));
  const added = add.map((a) => a.trim()).filter((a) => a && !have.has(norm(a)) && (have.add(norm(a)), true));
  return { items: [...current, ...added], added };
}

/** Remove items by name (exact, else a unique partial match). */
export function removeItems(current: string[], remove: string[]): { items: string[]; removed: string[]; notFound: string[] } {
  let items = [...current];
  const removed: string[] = [];
  const notFound: string[] = [];
  for (const r of remove) {
    const n = norm(r);
    let i = items.findIndex((x) => norm(x) === n);
    if (i < 0) {
      const partial = items.map((x, j) => [x, j] as const).filter(([x]) => norm(x).includes(n) || n.includes(norm(x)));
      i = partial.length === 1 ? partial[0][1] : -1;
    }
    if (i < 0) notFound.push(r);
    else {
      removed.push(items[i]);
      items = items.filter((_, j) => j !== i);
    }
  }
  return { items, removed, notFound };
}

// ---------------------------------------------------------------------------

async function findList(title: string) {
  const all = await native.notesList();
  return all.find((n) => n.title.toLowerCase() === title.toLowerCase()) ?? null;
}

export async function allLists(): Promise<Array<{ title: string; count: number }>> {
  const all = await native.notesList();
  return all.filter((n) => n.tags.split(/[,\s]+/).includes("list")).map((n) => ({ title: n.title, count: parseItems(n.body).length }));
}

export async function manageList(action: string, name: string, items: string[]): Promise<string> {
  if (action === "lists") {
    const ls = await allLists();
    return ls.length ? `Lists: ${ls.map((l) => `${l.title} (${l.count})`).join("; ")}` : "No lists yet.";
  }
  const title = listTitle(name);
  const note = await findList(title);
  const current = note ? parseItems(note.body) : [];
  const save = (next: string[]) => saveNote({ id: note?.id, title, body: formatItems(next), source: "list", tags: "list" });
  switch (action) {
    case "add": {
      if (!items.length) throw new Error("say what to add");
      const r = addItems(current, items);
      if (r.added.length) await save(r.items);
      return r.added.length ? `Added ${r.added.join(", ")} to your ${title.toLowerCase()} (${r.items.length} items).` : `Already on your ${title.toLowerCase()}.`;
    }
    case "remove": {
      if (!note) return `There's no ${title.toLowerCase()}.`;
      const r = removeItems(current, items);
      if (r.removed.length) await save(r.items);
      return `${r.removed.length ? `Took ${r.removed.join(", ")} off.` : ""}${r.notFound.length ? ` Couldn't find ${r.notFound.join(", ")}.` : ""} ${r.items.length} left.`.trim();
    }
    case "clear": {
      if (!note) return `There's no ${title.toLowerCase()}.`;
      await deleteNote(note.id);
      return `Cleared and removed your ${title.toLowerCase()}.`;
    }
    default:
      if (!note || !current.length) return `Your ${title.toLowerCase()} is empty.`;
      return `${title} (${current.length}):\n${formatItems(current)}`;
  }
}
