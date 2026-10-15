import { assertRepoFullName } from "@/security/input-sanitization";

export function splitRepo(fullName: string): { owner: string; repo: string } {
  assertRepoFullName(fullName);
  const [owner, repo] = fullName.split("/") as [string, string];
  return { owner, repo };
}
