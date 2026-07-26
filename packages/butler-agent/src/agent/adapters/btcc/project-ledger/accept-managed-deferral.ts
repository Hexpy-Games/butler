import type {
  BtccPersistenceTypes,
  WorkLedgerCommit,
} from "../../../btcc/gateway-api.ts";

type Program = BtccPersistenceTypes["managedProgramState"];
type Mutation = Extract<
  WorkLedgerCommit["mutation"],
  { kind: "accept_managed_deferral" }
>;

export function acceptManagedDeferral(
  program: Program,
  mutation: Mutation,
): Program {
  const { product, cursor } = mutation;
  if (
    program.manifestRevision !== cursor.expectedManifestRevision ||
    program.activeDeferral ||
    product.blocker.programId !== program.programId ||
    product.anchor.programId !== program.programId ||
    product.anchor.goalContractRef.id !== program.goalContractRef.id ||
    product.anchor.authorityRef.id !== program.authorityRef.id ||
    product.anchor.blockerRef.id !== product.blocker.ref.id
  ) {
    throw new Error("Project Work Ledger managed deferral changed");
  }
  return {
    ...structuredClone(program),
    activeDeferral: product,
    manifestRevision: program.manifestRevision + 1,
  };
}
