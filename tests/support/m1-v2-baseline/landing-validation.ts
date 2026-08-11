import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { validateProjectDeliverable } from
  "../btcc-revision-benchmark/project-deliverable-validation.ts";
import type {
  M1V2ApprovedCapabilityClaim,
  M1V2ApprovedCapabilityClaimId,
  M1V2LandingValidation,
} from "./contracts.ts";

const ORIGINAL_INDEX = "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Starter</title><link rel=\"stylesheet\" href=\"styles.css\"></head><body><main><h1>Starter</h1><p>Replace this page.</p></main></body></html>\n";
const ORIGINAL_STYLES = "body { margin: 0; font-family: system-ui, sans-serif; }\nmain { padding: 4rem; }\n";
const GENERIC_MARKETING_COPY = [
  /혁신적인\s*(?:AI|인공지능)/iu,
  /(?:AI|인공지능)\s*(?:비서|어시스턴트)/iu,
  /무한한\s*가능성/iu,
  /생산성(?:을|이)?\s*(?:극대화|혁신)/iu,
] as const;
const NEGATED_CLAIM = /(?:지원|제공|유지|활용|실행|복구)(?:하지|되지)\s*않|(?:없|불가능)(?:습니다|하다|한)|\b(?:does|do)\s+not\s+(?:support|provide|maintain|use|execute|recover)\b|\b(?:cannot|can't|doesn't|don't)\s+(?:support|provide|maintain|use|execute|recover)\b/iu;

const APPROVED_CAPABILITY_CLAIMS: ReadonlyArray<{
  id: M1V2ApprovedCapabilityClaimId;
  required: readonly RegExp[];
  misrepresentation: RegExp;
}> = [{
  id: "butler.durable_project_work.v1",
  required: [/(?:project|프로젝트)/iu, /(?:work|작업)/iu,
    /(?:durable|영속|지속|체크포인트|검토|review)/iu],
  misrepresentation: /(?:검토|review|승인).*(?:생략|없이)|자동으로?\s*완료|\bautomatically\s+completes?\b.*\bwithout\s+(?:review|approval)\b|\bcompletes?\b.*\bwithout\s+(?:review|approval)\b/iu,
}, {
  id: "butler.memory_context.v1",
  required: [/(?:memory|메모리|기억)/iu, /(?:context|컨텍스트|맥락)/iu],
  misrepresentation: /(?:모든|무제한).*(?:저장|기억|context|컨텍스트)|(?:stores?|remembers?)\s+(?:all|unlimited).*(?:memory|context)|(?:memory|context).*(?:without\s+limits?|unlimited)/iu,
}, {
  id: "butler.tools_workspace_authority.v1",
  required: [/(?:tool|도구)/iu, /(?:workspace|작업공간)/iu,
    /(?:권한|authority|범위|경계|안에서)/iu],
  misrepresentation: /(?:무제한|어디서나).*(?:파일|도구)|(?:workspace|작업공간)\s*(?:밖|외부).*(?:수정|접근)|(?:unrestricted|unlimited).*(?:files?|tools?|workspace)/iu,
}, {
  id: "butler.provider_routing.v1",
  required: [/(?:provider|프로바이더|제공자)/iu,
    /(?:route|routing|라우팅|경로|모델\s*선택)/iu],
  misrepresentation: /(?:항상|always).*(?:하나|동일|same).*(?:provider|프로바이더|모델)|(?:routing|라우팅).*(?:always).*(?:same).*(?:provider|model)|provider.*(?:무관|없음)/iu,
}, {
  id: "butler.recovery.v1",
  required: [/(?:recovery|recover|복구|재개|재시작)/iu,
    /(?:실패|중단|상태|checkpoint|체크포인트)/iu],
  misrepresentation: /(?:100\s*%|절대|항상).*(?:복구|실패하지)|(?:recovery|recover).*(?:always\s+succeeds?|100\s*%|never\s+fails?)|(?:always\s+succeeds?|100\s*%).*(?:recovery|recover)/iu,
}];

export async function validateM1V2Landing(input: {
  browserExecutablePath?: string;
  runRoot: string;
  workspaceRoot: string;
}): Promise<M1V2LandingValidation> {
  const indexPath = join(input.workspaceRoot, "index.html");
  const stylesPath = join(input.workspaceRoot, "styles.css");
  const html = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  const css = existsSync(stylesPath) ? readFileSync(stylesPath, "utf8") : "";
  const rendered = await validateProjectDeliverable({
    browserExecutablePath: input.browserExecutablePath ?? "",
    runRoot: input.runRoot,
    workspaceRoot: input.workspaceRoot,
  });
  const document = new JSDOM(html).window.document;
  const text = document.body?.textContent ?? "";
  const featureBlockCount = countFeatureBlocks(document);
  const claimElements = extractM1V2LandingClaimElements(document);
  const grounding = assessM1V2LandingGrounding(claimElements);
  return {
    buildPassed: rendered.build.exitCode === 0 && !rendered.build.timedOut,
    desktopPassed: viewportPassed(rendered.desktop),
    mobilePassed: viewportPassed(rendered.mobile),
    desktopScreenshotPresent: Boolean(rendered.desktop.screenshotPath &&
      existsSync(rendered.desktop.screenshotPath)),
    mobileScreenshotPresent: Boolean(rendered.mobile.screenshotPath &&
      existsSync(rendered.mobile.screenshotPath)),
    indexChanged: html !== ORIGINAL_INDEX,
    stylesChanged: css !== ORIGINAL_STYLES,
    butlerGrounded: /butler/iu.test(`${document.title} ${text}`),
    featureBlockCount,
    usageScenePresent: /(사용|활용|장면|상황|workflow|use\s*case)/iu.test(text),
    ctaPresent: document.querySelectorAll("a[href], button").length > 0,
    responsiveCssPresent: /@media\s*\(/iu.test(css),
    ...grounding,
  };
}

export function extractM1V2LandingClaimElements(document: Document): string[] {
  const selector = "article, li, section, p, [data-capability-claim]";
  const elements = [...document.querySelectorAll(selector)].filter((element) => {
    if (element.matches("[data-capability-claim]")) {
      return element.parentElement?.closest("[data-capability-claim]") === null;
    }
    if (element.closest("[data-capability-claim]")) return false;
    return element.querySelector(selector) === null;
  });
  return [...new Set(elements.map((element) =>
    element.textContent?.replace(/\s+/gu, " ").trim() ?? "").filter(Boolean))];
}

export function assessM1V2LandingGrounding(claimElements: readonly string[]): Pick<
  M1V2LandingValidation,
  "durableProjectWorkGrounded" | "memoryContextGrounded" |
    "toolsWorkspaceGrounded" | "providerRoutingGrounded" |
    "recoveryGrounded" | "genericCopyAbsent" | "approvedCapabilityClaims"
> {
  const approvedCapabilityClaims = APPROVED_CAPABILITY_CLAIMS.map((claim) =>
    assessApprovedClaim(claim, claimElements));
  const byId = new Map(approvedCapabilityClaims.map((claim) => [claim.id, claim.passed]));
  const text = claimElements.join(" ");
  return {
    durableProjectWorkGrounded: byId.get("butler.durable_project_work.v1") === true,
    memoryContextGrounded: byId.get("butler.memory_context.v1") === true,
    toolsWorkspaceGrounded: byId.get("butler.tools_workspace_authority.v1") === true,
    providerRoutingGrounded: byId.get("butler.provider_routing.v1") === true,
    recoveryGrounded: byId.get("butler.recovery.v1") === true,
    genericCopyAbsent: !GENERIC_MARKETING_COPY.some((pattern) => pattern.test(text)),
    approvedCapabilityClaims,
  };
}

function assessApprovedClaim(
  claim: typeof APPROVED_CAPABILITY_CLAIMS[number],
  claimElements: readonly string[],
): M1V2ApprovedCapabilityClaim {
  const element = claimElements.find((candidate) =>
    claim.required.every((pattern) => pattern.test(candidate)));
  const requiredElementsPresent = claim.required.map((pattern) =>
    Boolean(element && pattern.test(element)));
  const negated = Boolean(element && NEGATED_CLAIM.test(element));
  const misrepresented = Boolean(element && claim.misrepresentation.test(element));
  return {
    id: claim.id,
    requiredElementsPresent,
    negated,
    misrepresented,
    passed: requiredElementsPresent.every(Boolean) && !negated && !misrepresented,
  };
}

function countFeatureBlocks(document: Document): number {
  const explicit = document.querySelectorAll(
    "[class*='feature' i] article, [class*='feature' i] li, [class*='feature' i] > div",
  ).length;
  if (explicit >= 3) return explicit;
  const articles = document.querySelectorAll("main article").length;
  if (articles >= 3) return articles;
  return Math.max(explicit, articles);
}

function viewportPassed(viewport: {
  loaded: boolean;
  requestedWidth: number;
  innerWidth: number | null;
  clientWidth: number | null;
  scrollWidth: number | null;
}): boolean {
  return viewport.loaded && viewport.innerWidth === viewport.requestedWidth &&
    viewport.clientWidth === viewport.requestedWidth &&
    viewport.scrollWidth !== null && viewport.clientWidth !== null &&
    viewport.scrollWidth <= viewport.clientWidth;
}
