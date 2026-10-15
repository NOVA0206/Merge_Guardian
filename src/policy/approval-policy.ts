export interface ReviewRecord {
  id?: number;
  user: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  /** The commit the review was submitted against (GitHub `commit_id`). */
  commitId: string;
  submittedAt: string;
}

export interface ApprovalEvaluation {
  satisfied: boolean;
  validApprovers: string[];
  /** Why an otherwise-plausible approval did not count. */
  rejected: Array<{ user: string; reason: string }>;
  configurationMissing: boolean;
}

/**
 * Approval counts only if it is a native GitHub APPROVED review, from a designated approver, who is not
 * the PR author, submitted against the CURRENT head SHA, and not superseded by a later review.
 * A comment saying "approved" is never sufficient.
 */
export function evaluateApprovals(input: {
  reviews: readonly ReviewRecord[];
  headSha: string;
  approvers: readonly string[];
  required: number;
  prAuthor: string;
}): ApprovalEvaluation {
  const approvers = new Set(input.approvers.map((a) => a.toLowerCase()));
  if (approvers.size === 0) return { satisfied: false, validApprovers: [], rejected: [], configurationMissing: true };

  const latest = new Map<string, ReviewRecord>();
  for (const r of [...input.reviews].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))) {
    if (r.state === "COMMENTED" || r.state === "PENDING") continue; // comments never revoke or grant
    latest.set(r.user.toLowerCase(), r);
  }

  const valid: string[] = [];
  const rejected: ApprovalEvaluation["rejected"] = [];
  for (const [user, r] of latest) {
    if (r.state !== "APPROVED") {
      if (r.state === "CHANGES_REQUESTED" && approvers.has(user)) rejected.push({ user, reason: "latest review requests changes" });
      continue;
    }
    if (!approvers.has(user)) rejected.push({ user, reason: "not a designated approver" });
    else if (user === input.prAuthor.toLowerCase()) rejected.push({ user, reason: "authors cannot approve their own change" });
    else if (r.commitId !== input.headSha) rejected.push({ user, reason: `approval was for ${r.commitId.slice(0, 7)}, not current head ${input.headSha.slice(0, 7)}` });
    else valid.push(user);
  }
  return { satisfied: valid.length >= input.required, validApprovers: valid.sort(), rejected, configurationMissing: false };
}
