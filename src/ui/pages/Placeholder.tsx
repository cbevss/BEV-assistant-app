/**
 * Section shell for pages whose UI is scheduled in a later phase. It is NOT a
 * dead button: it names exactly what backs the page and what remains, so the
 * app ships honest about its own state.
 */
export function Placeholder({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div className="glass max-w-2xl rounded-xl border border-accent/15 p-5">
        <div className="mb-2 text-xs text-accent">
          wired backend · UI in progress
        </div>
        <p className="text-sm leading-relaxed text-ink-2">{hint}</p>
      </div>
    </div>
  );
}
