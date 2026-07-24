import type {
  GoverningSpecAuthority,
} from "../btcc/index.ts";
import type {
  BtccProjectLedgerRuntime,
} from "../adapters/index.ts";

export function createProjectGoverningSpecAuthority(
  runtime: BtccProjectLedgerRuntime,
): GoverningSpecAuthority | undefined {
  const listCanonicalSpecs = runtime.publications.listCanonicalSpecs?.bind(
    runtime.publications,
  );
  const resolveCanonicalSpecs = runtime.publications.resolveCanonicalSpecs?.bind(
    runtime.publications,
  );
  if (!listCanonicalSpecs || !resolveCanonicalSpecs) return undefined;
  return {
    async listCatalog(projectRef) {
      const revisions = await listCanonicalSpecs(
        runtime.resolveProjectRoot(projectRef),
      );
      return revisions.map(({ body: _body, ...metadata }) => metadata);
    },
    async resolveSelected(projectRef, logicalIds) {
      return resolveCanonicalSpecs(
        runtime.resolveProjectRoot(projectRef),
        logicalIds,
      );
    },
  };
}
