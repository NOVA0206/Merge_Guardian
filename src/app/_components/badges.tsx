const DECISION_STYLE: Record<string, string> = {
  PASS: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  PASS_WITH_WARNINGS: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  REQUIRES_APPROVAL: "bg-yellow-100 text-yellow-900 dark:bg-yellow-950 dark:text-yellow-200",
  BLOCKED: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  PENDING: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  STALE: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  ERROR: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
};

const STATUS_STYLE: Record<string, string> = {
  queued: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  running: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  succeeded: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  stale: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  cancelled: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

export function Pill({ text, kind }: { text: string; kind: "decision" | "status" }) {
  const style = (kind === "decision" ? DECISION_STYLE : STATUS_STYLE)[text] ?? "bg-slate-200 text-slate-700";
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}>{text.replace(/_/g, " ")}</span>;
}

const SEV_STYLE: Record<string, string> = {
  P0: "bg-red-600 text-white",
  P1: "bg-orange-500 text-white",
  P2: "bg-amber-400 text-slate-900",
  P3: "bg-slate-300 text-slate-900",
};

export function SeverityBadge({ severity }: { severity: string }) {
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-bold ${SEV_STYLE[severity] ?? ""}`}>{severity}</span>;
}
