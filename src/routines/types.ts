export type StepCondition =
  | { type: "always" }
  | { type: "process_running"; name: string }
  | { type: "process_not_running"; name: string };

export interface RoutineStep {
  id: string;
  /** Name of a registered tool (see src/ai/tools.ts). */
  tool: string;
  args: Record<string, unknown>;
  /** Wait this long BEFORE running the step. */
  delayMs?: number;
  condition?: StepCondition;
  /** Keep going if this step fails (default: stop the routine). */
  continueOnError?: boolean;
  /** Retries on failure before giving up (default 0). */
  retries?: number;
}

export interface RoutineSchedule {
  /** 24h "HH:MM" local time. */
  time: string;
  /** 0 = Sunday … 6 = Saturday. Empty = every day. */
  days: number[];
}

export interface Routine {
  id: string;
  name: string;
  description?: string;
  /** Spoken phrases that run it directly, e.g. "gaming mode". */
  triggers: string[];
  steps: RoutineStep[];
  schedule?: RoutineSchedule;
  enabled: boolean;
  builtIn?: boolean;
  lastRunAt?: number;
}

export type StepStatus = "pending" | "skipped" | "running" | "ok" | "failed" | "declined" | "cancelled";

export interface StepResult {
  stepId: string;
  tool: string;
  status: StepStatus;
  message: string;
}

export interface RunReport {
  routineId: string;
  name: string;
  ok: boolean;
  cancelled: boolean;
  results: StepResult[];
}
