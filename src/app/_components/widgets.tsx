"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** Database-backed progress: re-renders the server component every few seconds while a job is in flight. */
export function AutoRefresh({ active, everyMs = 4000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [active, everyMs, router]);
  return active ? <span className="text-xs text-slate-500" aria-live="polite">Refreshing automatically…</span> : null;
}

export function RetryButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  return (
    <div>
      <button
        type="button"
        disabled={state === "busy"}
        onClick={async () => {
          setState("busy");
          const res = await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
          setState(res.ok ? "idle" : "error");
          if (res.ok) router.refresh();
        }}
        className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-white dark:text-slate-900"
      >
        {state === "busy" ? "Retrying…" : "Retry analysis"}
      </button>
      {state === "error" && <p role="alert" className="mt-1 text-sm text-red-600">Retry was rejected (rate limited or no longer failed).</p>}
    </div>
  );
}

export function RepoToggle({ fullName, enabled }: { fullName: string; enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/repositories/toggle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fullName, enabled: !enabled }) });
        setBusy(false);
        router.refresh();
      }}
      className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
    >
      {enabled ? "Pause" : "Enable"}
    </button>
  );
}
