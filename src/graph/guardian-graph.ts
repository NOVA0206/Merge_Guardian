import { END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { GuardianDeps } from "./deps";
import { analyzeArchitecture, analyzeContracts, analyzeSecurity, runStaticAnalysis, semanticReview } from "./nodes/analyze";
import { classifySeverityNode, collectVerification, evaluatePolicy, mergeFindings, validateEvidence } from "./nodes/decide";
import { buildImpactGraph, loadArchitectureBaseline, loadPullRequest, parseDiff } from "./nodes/load";
import { finalizeDecision, publishReport, requestHumanApproval } from "./nodes/publish";
import { prepareRepair, rerunAnalysis, validateRepair, waitForUpdatedCommit } from "./nodes/repair";
import { afterLoadPullRequest, afterPublishReport, afterValidateRepair } from "./routing/routes";
import { GuardianState } from "./state";

/**
 * The Guardian workflow.
 *
 *   loadPullRequest -> loadArchitectureBaseline -> parseDiff -> buildImpactGraph
 *     -> [runStaticAnalysis | analyzeContracts | analyzeArchitecture | analyzeSecurity | semanticReview]   (parallel)
 *     -> mergeFindings -> validateEvidence -> classifySeverity -> collectVerification -> evaluatePolicy -> publishReport
 *     -> REQUIRES_APPROVAL: requestHumanApproval (pause) -> collectVerification -> ... (re-evaluated on resume)
 *     -> BLOCKED + authorised repair request: prepareRepair -> validateRepair -> waitForUpdatedCommit (pause) -> rerunAnalysis
 *     -> finalizeDecision
 *
 * All decisions are made by deterministic code (`evaluatePolicy`); the only model-backed node is `semanticReview`,
 * which can add advisory findings but never decides, approves, or merges.
 */
export function buildGuardianGraph(deps: GuardianDeps, checkpointer?: BaseCheckpointSaver) {
  const g = new StateGraph(GuardianState)
    .addNode("loadPullRequest", loadPullRequest(deps))
    .addNode("loadArchitectureBaseline", loadArchitectureBaseline(deps))
    .addNode("parseDiff", parseDiff(deps))
    .addNode("buildImpactGraph", buildImpactGraph(deps))
    .addNode("runStaticAnalysis", runStaticAnalysis(deps))
    .addNode("analyzeContracts", analyzeContracts(deps))
    .addNode("analyzeArchitecture", analyzeArchitecture(deps))
    .addNode("analyzeSecurity", analyzeSecurity(deps))
    .addNode("semanticReview", semanticReview(deps))
    .addNode("mergeFindings", mergeFindings(deps))
    .addNode("validateEvidence", validateEvidence(deps))
    .addNode("classifySeverity", classifySeverityNode(deps))
    .addNode("collectVerification", collectVerification(deps))
    .addNode("evaluatePolicy", evaluatePolicy(deps))
    .addNode("publishReport", publishReport(deps))
    .addNode("requestHumanApproval", requestHumanApproval(deps))
    .addNode("prepareRepair", prepareRepair(deps))
    .addNode("validateRepair", validateRepair(deps))
    .addNode("waitForUpdatedCommit", waitForUpdatedCommit(deps))
    .addNode("rerunAnalysis", rerunAnalysis(deps))
    .addNode("finalizeDecision", finalizeDecision(deps))

    .addEdge(START, "loadPullRequest")
    .addConditionalEdges("loadPullRequest", afterLoadPullRequest, ["loadArchitectureBaseline", "evaluatePolicy", "finalizeDecision"])
    .addEdge("loadArchitectureBaseline", "parseDiff")
    .addEdge("parseDiff", "buildImpactGraph");

  const analyzers = ["runStaticAnalysis", "analyzeContracts", "analyzeArchitecture", "analyzeSecurity", "semanticReview"] as const;
  for (const a of analyzers) g.addEdge("buildImpactGraph", a);
  g.addEdge([...analyzers], "mergeFindings");

  g.addEdge("mergeFindings", "validateEvidence")
    .addEdge("validateEvidence", "classifySeverity")
    .addEdge("classifySeverity", "collectVerification")
    .addEdge("collectVerification", "evaluatePolicy")
    .addEdge("evaluatePolicy", "publishReport")
    .addConditionalEdges("publishReport", afterPublishReport, ["requestHumanApproval", "prepareRepair", "finalizeDecision"])
    .addEdge("requestHumanApproval", "collectVerification")
    .addEdge("prepareRepair", "validateRepair")
    .addConditionalEdges("validateRepair", afterValidateRepair, ["waitForUpdatedCommit", "finalizeDecision"])
    .addEdge("waitForUpdatedCommit", "rerunAnalysis")
    .addEdge("rerunAnalysis", "finalizeDecision")
    .addEdge("finalizeDecision", END);

  return g.compile({ checkpointer });
}

export type GuardianGraph = ReturnType<typeof buildGuardianGraph>;
