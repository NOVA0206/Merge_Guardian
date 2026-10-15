import type { Decision, PolicyDecision } from "@/policy/decisions";
import type { CheckResult, Finding, Severity } from "./finding-schema";
import { sanitizeText } from "@/security/input-sanitization";
import { redactSecrets } from "@/security/secret-redaction";

export const REPORT_MARKER = "<!-- guardian-report:v1 -->";
const MAX_COMMENT = 60_000;

export interface RunMetadata {
  runId: string;
  repo: string;
  prNumber: number;
  baseBranch?: string;
  baseSha: string;
  headSha: string;
  /** GitHub's test-merge commit when available: the code that would actually land. */
  candidateSha?: string;
  guardianVersion: string;
  policyVersion: string;
  startedAt: string;
  completedAt?: string;
  filesChanged: number;
  affectedModules: string[];
  aiStatus: "ok" | "unavailable" | "skipped";
}

export interface ReportInput {
  meta: RunMetadata;
  decision: PolicyDecision;
  checks: readonly CheckResult[];
  mandatoryChecks: readonly string[];
  /** Tests Guardian recommends running for this change (from test-matrix + graph). */
  selectedTests?: string[];
  newEnvVars?: string[];
  dashboardUrl?: string;
}

/** Neutralise untrusted text for markdown: no HTML, no mentions, no secrets, bounded length. */
export function safeInline(text: string, max = 600): string {
  return redactSecrets(sanitizeText(text, max))
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "@​")
    .replace(/\r?\n/g, " ");
}

const SEVERITY_LABEL: Record<Severity, string> = { P0: "P0 — Critical", P1: "P1 — High", P2: "P2 — Medium", P3: "P3 — Low" };
const DECISION_EMOJI: Record<Decision, string> = {
  PASS: "✅",
  PASS_WITH_WARNINGS: "⚠️",
  REQUIRES_APPROVAL: "🟡",
  BLOCKED: "⛔",
  PENDING: "⏳",
  STALE: "♻️",
  ERROR: "❌",
};

const count = (f: readonly Finding[], s: Severity) => f.filter((x) => x.severity === s && x.status !== "dismissed" && x.status !== "resolved").length;

function checkLine(name: string, checks: readonly CheckResult[], headSha: string): string {
  const r = checks.find((c) => c.name === name && (!c.headSha || c.headSha === headSha));
  const status = r ? r.status : "NOT_RUN";
  const label = status === "PASS" ? "PASS" : status === "FAIL" ? "**FAIL**" : status === "PENDING" ? "PENDING" : "NOT RUN";
  return `- ${name}: ${label}${r?.detailsUrl ? ` ([details](${r.detailsUrl}))` : ""}`;
}

function renderFinding(f: Finding): string {
  const lines = [
    `### ${safeInline(f.title, 200)}${f.status === "waived" ? " _(waived by approval)_" : ""}`,
    "",
    `Severity: **${SEVERITY_LABEL[f.severity]}** · ${f.kind} · confidence ${(f.confidence * 100).toFixed(0)}% · \`${f.ruleId}\`${f.origin === "model" ? " · AI-suggested" : ""}`,
    "",
    safeInline(f.description, 900),
    "",
  ];
  if (f.affectedFiles.length) lines.push("Affected files:", ...f.affectedFiles.slice(0, 8).map((p) => `- \`${safeInline(p, 200)}\``), "");
  if (f.potentialImpact) lines.push(`**Impact:** ${safeInline(f.potentialImpact, 500)}`, "");
  if (f.evidence.length) {
    lines.push("**Evidence:**");
    for (const e of f.evidence.slice(0, 5)) {
      const loc = e.file ? `\`${safeInline(e.file, 200)}${e.line ? `:${e.line}` : ""}\` — ` : "";
      lines.push(`- ${loc}${safeInline(e.detail, 300)}`);
    }
    lines.push("");
  }
  if (f.recommendedFix) lines.push(`**Required action:** ${safeInline(f.recommendedFix, 500)}`, "");
  if (f.requiredTests.length) lines.push(`**Required tests:** ${f.requiredTests.slice(0, 8).map((t) => `\`${safeInline(t, 120)}\``).join(", ")}`, "");
  return lines.join("\n");
}

/** Build the single, updatable PR comment. Contains only real run data. */
export function buildReport(input: ReportInput): string {
  const { meta, decision } = input;
  const open = decision.findings.filter((f) => f.status === "open" || f.status === "waived");
  const shown = [...open].sort((a, b) => a.severity.localeCompare(b.severity));

  const out: string[] = [
    REPORT_MARKER,
    "## GitHub Merge Guardian",
    "",
    `**Decision:** ${DECISION_EMOJI[decision.decision]} ${decision.decision.replace(/_/g, " ")}`,
    "",
    `**Revision:** \`${meta.headSha}\` (base \`${meta.baseSha.slice(0, 12)}\`${meta.baseBranch ? ` on \`${safeInline(meta.baseBranch, 80)}\`` : ""}${meta.candidateSha ? `, merge candidate \`${meta.candidateSha.slice(0, 12)}\`` : ""})`,
    "",
    "**Summary:**",
    "",
    `- Files changed: ${meta.filesChanged}.`,
    `- Affected modules: ${meta.affectedModules.length}${meta.affectedModules.length ? ` (${meta.affectedModules.map((m) => safeInline(m, 40)).join(", ")})` : ""}.`,
    `- Critical findings: ${count(decision.findings, "P0")}.`,
    `- High findings: ${count(decision.findings, "P1")}.`,
    `- Medium findings: ${count(decision.findings, "P2")}.`,
    `- Low findings: ${count(decision.findings, "P3")}.`,
    "",
  ];

  if (shown.length) {
    out.push("## Findings", "");
    for (const f of shown) out.push(renderFinding(f));
  }

  out.push(
    "## Verification results",
    "",
    ...(input.mandatoryChecks.length ? input.mandatoryChecks.map((n) => checkLine(n, input.checks, meta.headSha)) : ["- No mandatory checks configured in `risk-policy.yaml`."]),
    `- AI analysis: ${meta.aiStatus === "ok" ? "completed" : meta.aiStatus === "unavailable" ? "UNAVAILABLE (deterministic analysis still applied)" : "not run"}`,
    "",
  );

  if (input.selectedTests?.length) out.push("**Tests selected for this change:** " + input.selectedTests.slice(0, 12).map((t) => `\`${safeInline(t, 120)}\``).join(", "), "");
  if (input.newEnvVars?.length) out.push(`**New environment variables to configure in Vercel:** ${input.newEnvVars.map((v) => `\`${safeInline(v, 80)}\``).join(", ")}`, "");

  if (decision.approval?.needed) {
    const ev = decision.approval.evaluation;
    out.push(
      "## Approval required",
      "",
      `An approving GitHub review on \`${meta.headSha.slice(0, 7)}\` from one of: ${decision.approval.approvers.map((a) => `\`${safeInline(a, 60)}\``).join(", ") || "_(no approvers configured)_"}.`,
      "A comment saying \"approved\" does not count. Pushing new commits invalidates earlier approvals.",
      ...ev.rejected.map((r) => `- Ignored review by \`${safeInline(r.user, 60)}\`: ${safeInline(r.reason, 160)}`),
      "",
    );
  }

  out.push("## Final decision", "", ...decision.reasons.map((r) => `- ${safeInline(r, 500)}`), "");
  out.push(
    "<sub>",
    `Run \`${meta.runId}\` · Guardian ${meta.guardianVersion} · policy \`${meta.policyVersion}\` · started ${meta.startedAt}${meta.completedAt ? ` · completed ${meta.completedAt}` : ""}`,
    input.dashboardUrl ? ` · [dashboard](${input.dashboardUrl})` : "",
    "</sub>",
  );

  const text = out.join("\n");
  return text.length > MAX_COMMENT ? text.slice(0, MAX_COMMENT) + "\n\n_…report truncated; see the dashboard for the full list._" : text;
}

/** One-line summary for the check run title. */
export function checkSummaryLine(decision: PolicyDecision): string {
  const open = decision.findings.filter((f) => f.status === "open");
  return `${decision.decision.replace(/_/g, " ")} — ${open.filter((f) => f.severity === "P0").length} critical, ${open.filter((f) => f.severity === "P1").length} high, ${open.filter((f) => f.severity === "P2").length} medium`;
}
