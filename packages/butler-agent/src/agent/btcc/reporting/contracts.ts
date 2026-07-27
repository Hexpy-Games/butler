import type { ContentRef } from "../core/index.ts";

export type PreparedReportProduct = {
  kind: "prepared_report";
  report: {
    ref: ContentRef;
    finalDossierRef: ContentRef;
    content: string;
    contentSha256: string;
  };
  finalPayload: {
    ref: ContentRef;
    turnId: string;
    reportRef: ContentRef;
    finalDossierRef: ContentRef;
    contentSha256: string;
    route: "managed";
    disposition: "completed" | "deferred";
    content: string;
  };
};
