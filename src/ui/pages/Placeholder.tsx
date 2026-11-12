/**
 * Section shell for pages whose UI is scheduled in a later phase. It is NOT a
 * dead button: it names exactly what backs the page and what remains, so the
 * app ships honest about its own state.
 */
export function Placeholder({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-glow">{title}</h1>
      <div className="glass max-w-2xl rounded-xl border border-bev-cyan/15 p-5">
        <div className="mb-2 text-xs uppercase tracking-widest text-bev-cyan">
          wired backend · UI in progress
        </div>
        <p className="text-sm leading-relaxed text-slate-300">{hint}</p>
      </div>
    </div>
  );
}
