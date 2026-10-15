import YAML from "yaml";
import { findSecrets } from "@/security/secret-redaction";
import type { Finding } from "@/reporting/finding-schema";
import { diffEvidence, modulesOf, ruleFinding, type AnalysisContext } from "./context";

const PLACEHOLDER = /^(?:|your[_-].*|changeme|change[_-]me|xxx+|\.\.\.|<.*>|\$\{.*\}|replace[_-]me|example.*|test|placeholder.*)$/i;

/** Credentials in added lines. Evidence NEVER includes the matched text. */
export function analyzeSecrets(ctx: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  for (const f of ctx.changes.files) {
    if (f.status === "deleted" || f.kinds.includes("lockfile")) continue;
    const isEnvFile = /(^|\/)\.env(\..+)?$/.test(f.path) && !/\.example$/.test(f.path);
    if (isEnvFile) {
      const hasValues = f.addedLines.some((l) => {
        const m = /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*\s*=\s*(.*)$/.exec(l.text);
        return m && !PLACEHOLDER.test(m[1]!.trim().replace(/^["']|["']$/g, ""));
      });
      if (hasValues) {
        findings.push(
          ruleFinding(
            "security/env-file-committed",
            {
              confidence: 0.9,
              kind: "probable",
              description: `${f.path} is committed with non-placeholder values.`,
              evidence: [diffEvidence(f.path, "Environment file with assigned values added to the repository (values withheld).")],
              affectedFiles: [f.path],
              affectedModules: modulesOf([f.path], ctx.config),
              potentialImpact: "Credentials in git history must be treated as compromised.",
              recommendedFix: "Remove the file, rotate every credential it contained, and add it to .gitignore. Use Vercel/GitHub encrypted secrets.",
              requiredTests: [],
            },
            f.path,
          ),
        );
      }
    }
    for (const l of f.addedLines) {
      for (const hit of findSecrets(l.text)) {
        // Allow obvious test fixtures that opt out explicitly.
        if (/guardian:allow-secret/.test(l.text)) continue;
        findings.push(
          ruleFinding(
            "security/secret-exposure",
            {
              confidence: 0.95,
              kind: "confirmed",
              description: `${hit.label} pattern found in ${f.path}:${l.line} (value withheld).`,
              evidence: [diffEvidence(f.path, `${hit.label} detected by pattern \`${hit.id}\`.`, l.line)],
              affectedFiles: [f.path],
              affectedModules: modulesOf([f.path], ctx.config),
              potentialImpact: "A credential in git history is exposed to everyone with repository access and must be considered compromised.",
              recommendedFix: "Revoke and rotate the credential immediately, remove it from the change (and history if already pushed), and load it from an encrypted secret.",
              requiredTests: [],
            },
            `${f.path}:${hit.id}:${l.line}`,
          ),
        );
      }
    }
  }
  return findings;
}

interface WorkflowDoc {
  on?: unknown;
  permissions?: unknown;
  jobs?: Record<string, { permissions?: unknown; steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }>;
}

function triggers(doc: WorkflowDoc): string[] {
  const on = doc.on ?? (doc as Record<string, unknown>)["true"];
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === "object") return Object.keys(on);
  return [];
}

export function analyzeWorkflows(ctx: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  for (const f of ctx.changes.files) {
    if (!f.kinds.includes("workflow") || f.status === "deleted") continue;
    const text = ctx.head.files.get(f.path) ?? "";
    let doc: WorkflowDoc;
    try {
      doc = (YAML.parse(text) ?? {}) as WorkflowDoc;
    } catch {
      continue;
    }
    const jobs = Object.values(doc.jobs ?? {});
    const steps = jobs.flatMap((j) => j.steps ?? []);

    if (triggers(doc).includes("pull_request_target")) {
      const checksOutHead = steps.some(
        (s) =>
          s.uses?.startsWith("actions/checkout") &&
          /github\.event\.pull_request\.head|github\.head_ref|refs\/pull\//.test(JSON.stringify(s.with ?? {})),
      );
      if (checksOutHead) {
        findings.push(
          ruleFinding(
            "security/pull-request-target",
            {
              confidence: 0.95,
              kind: "confirmed",
              description: `${f.path} uses \`pull_request_target\` and checks out the pull request head, running untrusted code with repository secrets and a write token.`,
              evidence: [diffEvidence(f.path, "pull_request_target trigger combined with actions/checkout of the PR head ref.")],
              affectedFiles: [f.path],
              affectedModules: [],
              potentialImpact: "A malicious fork PR can exfiltrate secrets or push code.",
              recommendedFix: "Use the `pull_request` trigger for untrusted code; split privileged steps into a separate workflow_run job that never checks out PR code.",
              requiredTests: [],
            },
            f.path,
          ),
        );
      }
    }
    const perms = [doc.permissions, ...jobs.map((j) => j.permissions)];
    if (perms.some((p) => p === "write-all" || (p && typeof p === "object" && Object.values(p as object).filter((v) => v === "write").length >= 4))) {
      findings.push(
        ruleFinding(
          "security/workflow-permissions",
          {
            confidence: 0.9,
            kind: "confirmed",
            description: `${f.path} grants broad write permissions to GITHUB_TOKEN.`,
            evidence: [diffEvidence(f.path, "permissions: write-all or four or more write scopes.")],
            affectedFiles: [f.path],
            affectedModules: [],
            potentialImpact: "Compromised steps can modify code, releases and settings.",
            recommendedFix: "Grant only the scopes each job needs (default `contents: read`).",
            requiredTests: [],
          },
          f.path,
        ),
      );
    }
    const unpinned = steps.filter((s) => s.uses && !s.uses.startsWith("./") && !s.uses.startsWith("actions/") && !/@[0-9a-f]{40}$/.test(s.uses));
    if (unpinned.length > 0) {
      findings.push(
        ruleFinding(
          "security/unpinned-action",
          {
            confidence: 0.9,
            kind: "informational",
            description: `${f.path} uses ${unpinned.length} third-party action(s) not pinned to a commit SHA: ${[...new Set(unpinned.map((s) => s.uses))].join(", ")}.`,
            evidence: [diffEvidence(f.path, "Mutable tag reference for a third-party action.")],
            affectedFiles: [f.path],
            affectedModules: [],
            potentialImpact: "A compromised tag can change what runs in CI.",
            recommendedFix: "Pin to a verified 40-character commit SHA.",
            requiredTests: [],
          },
          f.path,
        ),
      );
    }
  }
  return findings;
}

const AUTH_IDENT = /\b(getServerSession|getSession|requireAuth|requireUser|verifyToken|withAuth|currentUser|getUser|authenticate|isAuthenticated|auth\()/g;
const AUTH_PATH = /(^|\/)(auth|middleware|session|permissions|rbac)[^/]*\.[jt]sx?$|\/auth\//i;

export function analyzeAuth(ctx: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  for (const f of ctx.changes.files) {
    if (f.status === "deleted" || f.status === "added") continue;
    const before = ctx.base.files.get(f.previousPath ?? f.path) ?? "";
    const after = ctx.head.files.get(f.path) ?? "";
    const countBefore = before.match(AUTH_IDENT)?.length ?? 0;
    const countAfter = after.match(AUTH_IDENT)?.length ?? 0;
    const isRoute = f.kinds.includes("api-route") || /(^|\/)middleware\.[jt]s$/.test(f.path);
    if (isRoute && countBefore > 0 && countAfter === 0) {
      findings.push(
        ruleFinding(
          "auth/check-removed",
          {
            confidence: 0.8,
            kind: "probable",
            description: `${f.path} referenced authentication helpers before this change (${countBefore} uses) but none remain.`,
            evidence: [diffEvidence(f.path, `Authentication identifier count dropped from ${countBefore} to 0.`)],
            affectedFiles: [f.path],
            affectedModules: modulesOf([f.path], ctx.config),
            potentialImpact: "The endpoint may now be reachable without authentication.",
            recommendedFix: "Restore the authentication/authorization check or document why it moved, and add an unauthenticated-request test.",
            requiredTests: ["auth-regression"],
          },
          f.path,
        ),
      );
    } else if (AUTH_PATH.test(f.path) && f.status === "modified") {
      findings.push(
        ruleFinding(
          "auth/boundary-changed",
          {
            confidence: 0.7,
            kind: "potential",
            description: `${f.path} is part of the authentication/authorization boundary and was modified.`,
            evidence: [diffEvidence(f.path, "Path matches authentication/authorization naming convention.")],
            affectedFiles: [f.path],
            affectedModules: modulesOf([f.path], ctx.config),
            potentialImpact: "Subtle changes to session or permission logic can create bypasses.",
            recommendedFix: "Require review from a security-aware owner and run auth regression tests.",
            requiredTests: ["auth-regression"],
          },
          f.path,
        ),
      );
    }
  }
  return findings;
}
