/**
 * The main AI with backups. Each request goes to the main AI first; if it
 * can't answer (can't connect, key rejected, out of credit or rate-limited,
 * provider down, model gone), the next backup takes over, in the order the
 * user set. Problems with the request itself aren't retried elsewhere.
 */
import { create } from "zustand";
import type { AiProvider, AiResponse, ChatRequest } from "./types";
import { ProviderError } from "./types";
import { providerInfo, type ProviderId } from "./catalog";

/** Which AI answered last, so the app can show when a backup stepped in. */
export const useAiStatus = create<{ answeredBy: ProviderId | null; backupReason: string | null; at: number }>(() => ({
  answeredBy: null,
  backupReason: null,
  at: 0,
}));

export interface ChainLink {
  provider: AiProvider;
  /** This provider's quick-reply model, if it has one. */
  fast?: string;
}

/** Whether a failure means "try the next AI". */
export function shouldFallBack(e: unknown): boolean {
  if (!(e instanceof ProviderError)) return false;
  return e.kind !== "request";
}

const reasonFor = (e: unknown): string => {
  if (!(e instanceof ProviderError)) return "it failed";
  switch (e.kind) {
    case "network":
      return "it couldn't be reached";
    case "auth":
      return "its API key wasn't accepted";
    case "quota":
      return "it's out of credit or rate-limited";
    case "unavailable":
      return "it's unavailable right now";
    default:
      return "it failed";
  }
};

export class FallbackProvider implements AiProvider {
  readonly id: ProviderId;
  readonly label: string;

  constructor(private chain: ChainLink[]) {
    if (!chain.length) throw new Error("no AI configured");
    this.id = chain[0].provider.id;
    this.label = chain[0].provider.label;
  }

  async isConfigured(): Promise<boolean> {
    for (const l of this.chain) if (await l.provider.isConfigured().catch(() => false)) return true;
    return false;
  }

  async chat(req: ChatRequest): Promise<AiResponse> {
    const mainFast = this.chain[0].fast;
    const quick = !!req.model && req.model === mainFast;
    let firstError: unknown = null;

    for (let i = 0; i < this.chain.length; i++) {
      const { provider, fast } = this.chain[i];
      if (req.signal?.aborted) throw new DOMException("aborted", "AbortError");
      // Backups that aren't set up are skipped without a round trip.
      if (i > 0 && !(await provider.isConfigured().catch(() => false))) continue;
      // Quick replies use each provider's own fast model.
      const model = i === 0 ? req.model : quick ? fast || undefined : undefined;
      try {
        const r = await this.attempt(provider, { ...req, model });
        useAiStatus.setState({ answeredBy: provider.id, backupReason: i === 0 ? null : `${providerInfo(this.chain[0].provider.id).label}: ${reasonFor(firstError)}`, at: Date.now() });
        return r;
      } catch (e) {
        if (req.signal?.aborted) throw e;
        firstError ??= e;
        if (!shouldFallBack(e)) throw e;
      }
    }
    throw firstError ?? new ProviderError("no AI is set up", false, "auth");
  }

  /** One provider: if its fast model is the problem, try its main model before giving up on it. */
  private async attempt(p: AiProvider, req: ChatRequest): Promise<AiResponse> {
    try {
      return await p.chat(req);
    } catch (e) {
      const fastModelProblem = req.model && e instanceof ProviderError && (e.kind === "unavailable" || e.kind === "request");
      if (!fastModelProblem || req.signal?.aborted) throw e;
      return p.chat({ ...req, model: undefined, maxTokens: Math.max(req.maxTokens ?? 0, 2048) });
    }
  }
}
