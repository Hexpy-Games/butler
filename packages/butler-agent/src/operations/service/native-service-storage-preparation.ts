import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  activateAgentBtccStorage,
  agentBtccStoragePaths,
  prepareAgentBtccStorage,
  validateAgentBtccStorageForReadiness,
} from "../../agent/adapters/btcc/sqlite/storage-ownership/index.ts";

export async function prepareAgentStorageForNativeServiceLaunch(input: {
  butlerData: string;
  runtimeVersion: string;
  quiesceLegacyWriter: () => Promise<void>;
}): Promise<void> {
  const paths = agentBtccStoragePaths(input.butlerData);
  const migrationRequired = !existsSync(paths.agentBtccDbPath);
  const legacySourceExists = migrationRequired && existsSync(paths.legacyAppDbPath);
  const migrationFencePath = join(
    input.butlerData,
    "locks",
    "app-gateway-migration-fence",
  );
  let legacyWriteFence: Database | undefined;

  try {
    if (legacySourceExists) {
      mkdirSync(join(input.butlerData, "locks"), { recursive: true });
      writeFileSync(migrationFencePath, `${process.pid}\n`);
    }
    await prepareAgentBtccStorage({
      butlerData: input.butlerData,
      quiesceLegacyWriter: async () => {
        if (legacySourceExists) {
          await input.quiesceLegacyWriter();
          legacyWriteFence = new Database(paths.legacyAppDbPath);
          legacyWriteFence.exec("BEGIN IMMEDIATE");
        }
        return {
          fenceId: `native-service-pre-readiness:${process.pid}`,
          reconciledClaims: 0,
          parkedClaims: 0,
        };
      },
    });
    activateAgentBtccStorage({
      butlerData: input.butlerData,
      runtimeVersion: input.runtimeVersion,
    });
  } finally {
    if (legacyWriteFence?.inTransaction) legacyWriteFence.exec("ROLLBACK");
    legacyWriteFence?.close();
    rmSync(migrationFencePath, { force: true });
  }
  validateAgentBtccStorageForReadiness({ butlerData: input.butlerData });
}

export async function restartNativeServicesAfterStoragePreparation<T>(input: {
  prepareStorage: () => Promise<void>;
  stopServices: () => void;
  startServices: () => T;
}): Promise<T> {
  await input.prepareStorage();
  input.stopServices();
  return input.startServices();
}
