import Link from "next/link";
import { redirect } from "next/navigation";
import { accessibleRepoNames } from "@/lib/access";
import { getSession } from "@/lib/session";
import { getStore } from "@/storage";
import { Pill } from "../_components/badges";
import { AutoRefresh, RepoToggle } from "../_components/widgets";

export const dynamic = "force-dynamic";

const NOTICES: Record<string, string> = {
  bad_installation: "The installation link was invalid.",
  not_authorized: "You do not have access to that installation.",
  sync_failed: "The installation was found but repositories could not be synced. Try again shortly.",
};

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ error?: string; connected?: string }> }) {
  const session = await getSession();
  if (!session) redirect("/api/auth/login?returnTo=/dashboard");
  const { error, connected } = await searchParams;

  const store = getStore();
  const names = await accessibleRepoNames(session);
  const repos = (await store.listRepositories(names === "all" ? undefined : session.installationIds)).sort((a, b) => a.fullName.localeCompare(b.fullName));
  const jobs = names !== "all" && names.length === 0 ? [] : await store.listJobs({ repoFullNames: names === "all" ? undefined : names, limit: 30 });
  const active = jobs.some((j) => j.status === "queued" || j.status === "running");
  const slug = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;

  return (
    <main>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4 dark:border-slate-800">
        <Link href="/" className="text-lg font-semibold tracking-tight">GitHub Merge Guardian</Link>
        <form action="/api/auth/logout" method="post" className="flex items-center gap-3 text-sm">
          <span className="text-slate-600 dark:text-slate-300">Signed in as <strong>{session.login}</strong></span>
          <button className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">Sign out</button>
        </form>
      </header>

      {connected && <p role="status" className="mt-4 rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">Connected {connected}. Open a pull request to see Guardian run.</p>}
      {error && <p role="alert" className="mt-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">{NOTICES[error] ?? "Something went wrong."}</p>}

      <section className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Repositories</h2>
          {slug && <a className="text-sm text-emerald-700 hover:underline dark:text-emerald-400" href={`https://github.com/apps/${slug}/installations/new`}>Connect another account or repository →</a>}
        </div>
        {repos.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">
            No repositories connected yet. Install the GitHub App on a repository to get started.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            {repos.map((r) => (
              <li key={r.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <span className="font-mono">{r.fullName}</span>
                <span className="flex items-center gap-3">
                  <span className={r.enabled ? "text-emerald-700 dark:text-emerald-400" : "text-slate-500"}>{r.enabled ? "Analysing" : "Paused"}</span>
                  <RepoToggle fullName={r.fullName} enabled={r.enabled} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Recent analyses</h2>
          <AutoRefresh active={active} />
        </div>
        {jobs.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">No analyses yet. They appear here as soon as a pull request is opened or updated.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-800">
                <tr>
                  <th className="px-4 py-2">Pull request</th>
                  <th className="px-4 py-2">Head</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Decision</th>
                  <th className="px-4 py-2">Updated</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                    <td className="px-4 py-2">
                      <Link className="font-mono text-emerald-700 hover:underline dark:text-emerald-400" href={`/dashboard/jobs/${j.id}`}>
                        {j.repoFullName}#{j.prNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{j.headSha.slice(0, 7)}</td>
                    <td className="px-4 py-2"><Pill text={j.status} kind="status" /></td>
                    <td className="px-4 py-2">{j.decision ? <Pill text={j.decision} kind="decision" /> : <span className="text-slate-400">—</span>}</td>
                    <td className="px-4 py-2 text-xs text-slate-500"><time dateTime={j.updatedAt}>{new Date(j.updatedAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC</time></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
