/** GitHub: notifications, issues and pull requests with a personal access token. */
import type { RegisteredTool } from "@/ai/tools";
import { native } from "@/lib/native";
import { api } from "./http";
import { str, optStr, clip } from "./args";

export const GH_TOKEN = "github_token";
const GH = "https://api.github.com";
async function gh<T>(path: string, body?: unknown, method?: string) {
  const token = await native.getSecret(GH_TOKEN);
  if (!token) throw new Error("GitHub isn't set up: add a token in Integrations");
  return api<T>(`${GH}${path}`, { token, body, method, headers: { "X-GitHub-Api-Version": "2022-11-28", Accept: "application/vnd.github+json" } });
}
const repoArg = (v: unknown) => {
  const r = str(v, "repo");
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error('repo must look like "owner/name"');
  return r;
};

interface Issue {
  number: number;
  title: string;
  state: string;
  user?: { login: string };
  pull_request?: unknown;
  updated_at: string;
  html_url: string;
  comments?: number;
}

export function githubTools(): Record<string, RegisteredTool> {
  return {
    github_notifications: {
      spec: { name: "github_notifications", description: "Unread GitHub notifications (reviews requested, mentions, CI, issues).", parameters: { type: "object", properties: {}, required: [] } },
      untrustedOutput: true,
      run: async () => {
        const n = await gh<Array<{ reason: string; repository: { full_name: string }; subject: { title: string; type: string }; updated_at: string }>>("/notifications?per_page=20");
        return n.length ? n.map((x) => `${x.repository.full_name}: ${x.subject.type} "${x.subject.title}" (${x.reason})`).join("\n") : "No unread notifications.";
      },
    },
    github_issues: {
      spec: {
        name: "github_issues",
        description: "List open (or closed) issues and pull requests in a GitHub repository, newest activity first.",
        parameters: { type: "object", properties: { repo: { type: "string", description: "owner/name" }, state: { type: "string", enum: ["open", "closed", "all"] } }, required: ["repo"] },
      },
      untrustedOutput: true,
      run: async (a) => {
        const state = ["open", "closed", "all"].includes(String(a.state)) ? String(a.state) : "open";
        const items = await gh<Issue[]>(`/repos/${repoArg(a.repo)}/issues?state=${state}&sort=updated&per_page=20`);
        return items.length ? items.map((i) => `#${i.number} ${i.pull_request ? "PR" : "issue"} "${clip(i.title, 100)}" by ${i.user?.login ?? "?"}, ${i.comments ?? 0} comments`).join("\n") : "Nothing found.";
      },
    },
    github_pr_status: {
      spec: {
        name: "github_pr_status",
        description: "Status of a pull request: checks, review state, mergeability.",
        parameters: { type: "object", properties: { repo: { type: "string" }, number: { type: "number" } }, required: ["repo", "number"] },
      },
      untrustedOutput: true,
      run: async (a) => {
        const repo = repoArg(a.repo);
        const pr = await gh<{ title: string; state: string; merged: boolean; mergeable_state?: string; head: { sha: string }; draft?: boolean }>(`/repos/${repo}/pulls/${Number(a.number)}`);
        const checks = await gh<{ check_runs: Array<{ name: string; status: string; conclusion: string | null }> }>(`/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=30`).catch(() => ({ check_runs: [] }));
        const failing = checks.check_runs.filter((c) => c.conclusion && !["success", "skipped", "neutral"].includes(c.conclusion));
        const pending = checks.check_runs.filter((c) => c.status !== "completed");
        return `"${pr.title}": ${pr.merged ? "merged" : pr.state}${pr.draft ? " (draft)" : ""}, ${pr.mergeable_state ?? "mergeability unknown"}. Checks: ${checks.check_runs.length} total, ${failing.length} failing${failing.length ? ` (${failing.map((f) => f.name).join(", ")})` : ""}, ${pending.length} running.`;
      },
    },
    github_create_issue: {
      spec: {
        name: "github_create_issue",
        description: "Open a new issue in a GitHub repository (the user confirms first).",
        parameters: { type: "object", properties: { repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["repo", "title"] },
        sensitive: true,
      },
      run: async (a) => {
        const i = await gh<Issue>(`/repos/${repoArg(a.repo)}/issues`, { title: str(a.title, "title"), body: optStr(a.body) ?? "" });
        return `Opened issue #${i.number}: ${i.html_url}`;
      },
    },
  };
}

export async function testGitHub(): Promise<string> {
  const u = await gh<{ login: string }>("/user");
  return `Signed in as ${u.login}.`;
}
