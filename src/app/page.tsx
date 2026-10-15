import Link from "next/link";
import { configStatus } from "@/config/env";

const ERRORS: Record<string, string> = {
  oauth_state: "Sign-in could not be verified. Please try again.",
  oauth_failed: "GitHub sign-in failed. Please try again.",
  configuration: "This deployment is not fully configured yet.",
};

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const slug = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;
  const cfg = configStatus();
  return (
    <main>
      <header className="flex items-center justify-between border-b border-slate-200 pb-4 dark:border-slate-800">
        <span className="text-lg font-semibold tracking-tight">GitHub Merge Guardian</span>
        <Link href="/api/auth/login" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200">
          Sign in with GitHub
        </Link>
      </header>

      {error && (
        <div role="alert" className="mt-6 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          <p className="font-semibold">{ERRORS[error] ?? "Something went wrong."}</p>
          {error === "configuration" && cfg.missing.length > 0 && (
            <div className="mt-2 text-xs">
              <p>Missing environment variables:</p>
              <ul className="mt-1 list-inside list-disc font-mono">
                {cfg.missing.map((key) => (
                  <li key={key}>{key}</li>
                ))}
              </ul>
              <p className="mt-2 text-slate-700 dark:text-slate-300">
                Copy <code>.env.example</code> to <code>.env.local</code> and fill in your GitHub App credentials and <code>DATABASE_URL</code>.
              </p>
            </div>
          )}
        </div>
      )}

      <section className="py-14">
        <h1 className="max-w-2xl text-4xl font-semibold tracking-tight">Merge only what you have verified, not what merely compiles.</h1>
        <p className="mt-4 max-w-2xl text-lg text-slate-600 dark:text-slate-300">
          Guardian checks every pull request against your architecture, API and database contracts, environment requirements and security rules, then reports a
          deterministic, auditable decision as a required GitHub check.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          {slug && (
            <a href={`https://github.com/apps/${slug}/installations/new`} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
              Install the GitHub App
            </a>
          )}
          <Link href="/dashboard" className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-900">
            Open dashboard
          </Link>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {[
          ["Deterministic decisions", "Severity and the final verdict come from policy code. The AI can add findings, never approve or merge."],
          ["Evidence, not opinions", "Every finding cites real files and lines. Unverifiable AI claims are discarded or demoted."],
          ["Fails closed", "Missing checks, stale commits and provider outages never turn into a green check."],
        ].map(([title, body]) => (
          <div key={title} className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="font-medium">{title}</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{body}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
