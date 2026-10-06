// Real host-helper pipe handshake with a stub installer, never the owner's App.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareAppPackageUpdate } from "../../packages/butler-app/client/electron/app-package-update.mjs";

const root = await mkdtemp(join(tmpdir(), "butler-update-host-"));
try {
  const helper = join(root, "helper.mjs");
  const signal = join(root, "signal");
  await writeFile(helper, `import { writeFileSync } from "node:fs";\nconsole.log("app-update-ready");\nprocess.stdin.once("data", bytes => { writeFileSync(${JSON.stringify(signal)}, bytes); process.exit(0); });\nprocess.stdin.on("end", () => process.exit(0));`);
  const data = join(root, "data");
  await mkdir(join(data, "updates/artifacts"), { recursive: true });
  await mkdir(join(data, "updates/staged"), { recursive: true });
  for (const name of ["Butler.zip", "butler-app-1.1.0-full.nupkg"]) {
    const artifact = join(data, "updates/artifacts", name);
    const bytes = Buffer.from("stub verified package");
    await writeFile(artifact, bytes);
    const staged = { artifact_path: `updates/artifacts/${name}`, available_version: "1.1.0", sha256: createHash("sha256").update(bytes).digest("hex") };
    await writeFile(join(data, "updates/staged/app.json"), JSON.stringify(staged));
    const phases: string[] = [];
    const prepared = await prepareAppPackageUpdate({ artifactPath: artifact, dataRoot: data,
      installation: { command: process.execPath, args: [helper] }, executable: helper, parent: process.pid,
      onStage: async (stage: string) => { phases.push(stage); } });
    assert.deepEqual(phases, ["verifying", "ready"]);
    prepared.activate();
    const deadline = Date.now() + 5000;
    while (!(await Bun.file(signal).exists()) && Date.now() < deadline) await Bun.sleep(10);
    assert.equal(await readFile(signal, "utf8"), "activate\n");
    await rm(signal);
    await writeFile(artifact, "changed after staging");
    await assert.rejects(prepareAppPackageUpdate({ artifactPath: artifact, dataRoot: data,
      installation: { command: process.execPath, args: [helper] }, executable: helper, parent: process.pid }), /checksum changed/);
  }
  console.log(JSON.stringify({ ok: true, packages: ["zip", "nupkg"], phases: ["verifying", "ready"], activationSignal: true, changedChecksumRejected: true }));
} finally { await rm(root, { recursive: true, force: true }); }
