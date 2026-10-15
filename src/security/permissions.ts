import { PolicyViolationError } from "@/errors";

/**
 * Files a repair agent may never modify: Guardian's own policy, CI enforcement,
 * branch-protection tooling, and secrets. Evaluated against repo-relative POSIX paths.
 */
export const REPAIR_FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /^\.guardian\//,
  /^\.github\/(workflows|CODEOWNERS|rulesets)(\/|$)/,
  /(^|\/)\.env(\..*)?$/,
  /\.pem$/,
  /^src\/(policy|security)\//,
  /^vercel\.json$/,
];

export function isRepairPathForbidden(path: string): boolean {
  return REPAIR_FORBIDDEN_PATTERNS.some((re) => re.test(path));
}

export function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|e2e)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

export type RepoPermission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

/** Repairs may be requested only by actors with write access (and on the allow-list when one is set). */
export function assertRepairActorAuthorized(
  actor: string,
  allowedActors: readonly string[],
  actorPermission: RepoPermission,
): void {
  const privileged = actorPermission === "admin" || actorPermission === "maintain" || actorPermission === "write";
  if (!privileged || (allowedActors.length > 0 && !allowedActors.includes(actor))) {
    throw new PolicyViolationError(`Actor ${actor} is not authorized to request a repair`);
  }
}
