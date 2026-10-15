import type { GitHubGateway } from "@/github/gateway";
import type { GuardianDeps } from "@/graph/deps";
import { PolicyViolationError } from "@/errors";
import { assertRepairActorAuthorized } from "@/security/permissions";
import { safeErrorMessage } from "@/security/secret-redaction";
import type { Store } from "@/storage/store";
import { deterministicGenerator, generatePatch, ModelPatchGenerator, type PatchGenerator } from "./patch-generator";
import { validatePatch } from "./patch-validator";
import { planRepairTests } from "./test-runner";

type RepairHook = NonNullable<GuardianDeps["repair"]>;

export interface RepairControllerOptions {
  store: Store;
  /** Write-scoped gateway factory; only ever used here. */
  gatewayFor: (installationId: number) => GitHubGateway;
  reviewerKey?: string;
  model?: string;
  allowedActors?: string[];
  generators?: PatchGenerator[];
}

const PROTECTED_BRANCHES = /^(main|master|develop|production|release\/.*)$/;

/**
 * Repair pipeline (spec section 13). It never pushes to the feature branch or main: output is a draft PR
 * from a dedicated `guardian/fix-PR-<n>` branch, to be verified by isolated CI and approved by a developer.
 */
export function createRepairHook(opts: RepairControllerOptions): RepairHook {
  const generators = opts.generators ?? [deterministicGenerator, ...(opts.reviewerKey ? [new ModelPatchGenerator(opts.reviewerKey, opts.model ?? "claude-sonnet-5-5")] : [])];

  return async ({ repoFullName, prNumber, installationId, findingId, sourceHeadSha, requestedBy, ctx, findings }) => {
    const { store } = opts;
    const gh = opts.gatewayFor(installationId);
    const session = (await store.listRepairSessions({ repoFullName, prNumber })).find((s) => s.status === "requested" && s.findingId === findingId && s.sourceHeadSha === sourceHeadSha);
    const fail = async (detail: string, reasons: string[] = []) => {
      if (session) await store.updateRepairSession(session.id, { status: "failed", result: { detail, reasons } });
      await store.appendAudit({ actor: "guardian", action: "repair.failed", repoFullName, prNumber, headSha: sourceHeadSha, details: { findingId, detail, reasons } });
      return { status: "failed" as const, sessionId: session?.id, detail: [detail, ...reasons].join(" ") };
    };

    try {
      if (!session) return await fail("No matching repair request for this exact commit.");
      await store.updateRepairSession(session.id, { status: "running", attempts: session.attempts + 1 });

      // Re-check authorization at execution time (permissions may have changed since the comment).
      assertRepairActorAuthorized(requestedBy, opts.allowedActors ?? [], await gh.getCollaboratorPermission(repoFullName, requestedBy));

      const pr = await gh.getPullRequest(repoFullName, prNumber);
      if (pr.headSha !== sourceHeadSha) return await fail("The PR head moved since the repair was requested; request it again.");
      if (pr.isFork) return await fail("Repair branches cannot be created for fork pull requests.");
      if (PROTECTED_BRANCHES.test(pr.headRef)) return await fail(`Refusing to target protected branch ${pr.headRef}.`);

      const finding = findings.find((f) => f.id === findingId && f.repairable && f.status === "open");
      if (!finding) return await fail("Finding is not open and repairable on this commit.");

      const generated = await generatePatch(ctx, finding, generators);
      if (!generated) return await fail("No safe automated fix is available for this finding; human intervention required.");

      const validation = validatePatch(generated.patch, ctx, finding);
      if (!validation.ok) return await fail("Generated patch was rejected by validation.", validation.reasons);

      const tests = planRepairTests(finding, ctx);
      const branch = `guardian/fix-PR-${prNumber}`;
      await gh.createBranchFromSha(repoFullName, branch, sourceHeadSha);
      await gh.commitFiles(repoFullName, branch, `guardian: ${generated.patch.summary}\n\nFixes finding ${finding.id} (${finding.ruleId}) on ${sourceHeadSha.slice(0, 12)}.`, generated.patch.files);
      const repairPr = await gh.openPullRequest(repoFullName, {
        head: branch,
        base: pr.headRef,
        title: `Guardian fix for #${prNumber}: ${finding.title}`.slice(0, 200),
        body: [
          `Automated repair proposed by GitHub Merge Guardian for #${prNumber}. **Draft: do not merge until checks pass and a developer has reviewed the diff.**`,
          "",
          `- Finding: \`${finding.id}\` (${finding.ruleId})`,
          `- Source revision: \`${sourceHeadSha}\``,
          `- Strategy: ${generated.generator}`,
          `- Requested by: @${requestedBy}`,
          `- Files changed: ${validation.diff.map((d) => `\`${d.path}\` (+${d.additions}/-${d.deletions})`).join(", ")}`,
          "",
          "**Validation performed before publishing:** scope check, syntax check, and a full re-run of Guardian's analyzers on the patched tree (targeted finding gone; no new P0/P1).",
          `**To be verified by isolated CI on this PR:** ${tests.map((t) => `\`${t}\``).join(", ")}.`,
          "",
          "Guardian will analyse this PR as it would any other. After merging it into the feature branch, a fresh analysis runs on the new commit; the original result is not reused.",
        ].join("\n"),
        draft: true,
      });
      await store.updateRepairSession(session.id, { status: "proposed", repairPrNumber: repairPr, result: { generator: generated.generator, summary: generated.patch.summary, files: validation.diff, tests } });
      await store.appendAudit({ actor: "guardian", action: "repair.proposed", repoFullName, prNumber, headSha: sourceHeadSha, details: { findingId, branch, repairPr, generator: generated.generator, requestedBy } });
      return { status: "proposed" as const, branch, repairPrNumber: repairPr, sessionId: session.id, detail: `Draft repair PR #${repairPr} opened on ${branch}.` };
    } catch (err) {
      if (err instanceof PolicyViolationError) {
        await store.appendAudit({ actor: requestedBy, action: "repair.denied", repoFullName, prNumber, headSha: sourceHeadSha, details: { reason: err.message } });
        return await fail("Not authorized.", [err.message]);
      }
      return await fail("Repair failed unexpectedly.", [safeErrorMessage(err)]);
    }
  };
}
