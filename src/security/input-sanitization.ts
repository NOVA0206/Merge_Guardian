import { ValidationError } from "@/errors";

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Strip control characters and cap length for untrusted text (PR titles, bodies, file content). */
export function sanitizeText(input: string, maxLength = 4000): string {
  const cleaned = input.replace(CONTROL, "");
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) + "...[truncated]" : cleaned;
}

/** Escape text for inclusion in GitHub-flavoured markdown paragraphs and tables. */
export function escapeMarkdown(input: string): string {
  return sanitizeText(input, 2000)
    .replace(/[\\`*_{}[\]<>#|]/g, (c) => `\\${c}`)
    .replace(/@/g, "@​");
}

/** Wrap untrusted repository content for a model prompt so it is clearly data, never instructions. */
export function fenceUntrusted(label: string, content: string, maxLength = 6000): string {
  const body = sanitizeText(content, maxLength).replace(/<\/?untrusted[^>]*>/gi, "");
  return `<untrusted source="${label.replace(/[^\w./@-]/g, "_")}">\n${body}\n</untrusted>`;
}

// Includes [] and () so Next.js dynamic routes and route groups (e.g. app/api/[id]/route.ts) are valid.
const SAFE_PATH = /^[\w.@+\-/ ()[\]]+$/;

/** Validate a repo-relative POSIX path: no traversal, no absolute paths, no .git internals. */
export function assertSafeRepoPath(p: string): string {
  const norm = p.replace(/\\/g, "/");
  if (!norm || norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) throw new ValidationError(`Unsafe path: ${p}`);
  const parts = norm.split("/");
  if (parts.some((s) => s === ".." || s === "." || s === "")) throw new ValidationError(`Unsafe path: ${p}`);
  if (parts[0] === ".git") throw new ValidationError(`Path targets .git: ${p}`);
  if (!SAFE_PATH.test(norm)) throw new ValidationError(`Unsafe path characters: ${p}`);
  return norm;
}

export const GIT_SHA = /^[0-9a-f]{40}$/;
export function assertSha(sha: string): string {
  if (!GIT_SHA.test(sha)) throw new ValidationError(`Invalid git SHA: ${sha}`);
  return sha;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export function assertRepoFullName(name: string): string {
  if (!REPO.test(name)) throw new ValidationError(`Invalid repository name: ${name}`);
  return name;
}
