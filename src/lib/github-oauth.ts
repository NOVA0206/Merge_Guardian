import { getEnv } from "@/config/env";
import { githubApiUrl, githubWebUrl } from "@/config/github-urls";

export function authorizeUrl(state: string, redirectUri: string): string {
  const u = new URL(`${githubWebUrl()}/login/oauth/authorize`);
  u.searchParams.set("client_id", getEnv().GITHUB_APP_CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  return u.toString();
}

export async function exchangeCode(code: string, redirectUri: string): Promise<string> {
  const env = getEnv();
  const res = await fetch(`${githubWebUrl()}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_APP_CLIENT_ID, client_secret: env.GITHUB_APP_CLIENT_SECRET, code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !json.access_token) throw new Error(`OAuth exchange failed${json.error ? `: ${json.error}` : ""}`);
  return json.access_token;
}

async function gh<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${githubApiUrl()}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "github-merge-guardian" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchUser(token: string) {
  return gh<{ login: string; id: number }>("/user", token);
}

/** Installations of THIS GitHub App that the user can access (user-to-server token). */
export async function fetchUserInstallations(token: string): Promise<number[]> {
  const out: number[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await gh<{ installations: Array<{ id: number }> }>(`/user/installations?per_page=100&page=${page}`, token);
    out.push(...r.installations.map((i) => i.id));
    if (r.installations.length < 100) break;
  }
  return out;
}
