import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveWorkspacePathGuard } from "../shared/workspace-path-guard.ts";
import { fileToolEvidenceReceipt, sha256Hex } from "../shared/evidence.ts";
import { getWorkspaceRoot, parseToolArgs } from "../shared/args.ts";
import type { FileToolExecutionContext } from "../read_file/executor.ts";
export async function executeWriteFileTool(call: { arguments?: unknown; input?: unknown; args?: unknown }, context: FileToolExecutionContext = {}) {
 const a=parseToolArgs(call); const workspace_root=getWorkspaceRoot(a, context.workspacePath); const path=String(a.path??""); const content=String(a.content??""); const overwrite=Boolean(a.overwrite); const expected=typeof a.expected_sha256==="string"?a.expected_sha256:undefined;
 const guard=await resolveWorkspacePathGuard({workspaceRoot:workspace_root, relativePath:path, allowMissingLeaf:true}); if(!guard.ok) return {ok:false,error:guard.reason,path,guard};
 let existed=false, before_sha256:string|undefined; try { const st=await stat(guard.absolutePath!); if(!st.isFile()) return {ok:false,error:"target_not_regular_file",path}; existed=true; const before=await readFile(guard.absolutePath!); before_sha256=sha256Hex(before); if(!overwrite) return {ok:false,error:"file_exists",path,before_sha256}; if(expected && before_sha256!==expected) return {ok:false,error:"expected_sha256_mismatch",path,before_sha256,expected_sha256:expected}; } catch(e) { if(expected) return {ok:false,error:"expected_sha256_on_missing_file",path,expected_sha256:expected}; }
 await mkdir(dirname(guard.absolutePath!),{recursive:true}); const tmp=`${guard.absolutePath!}.butler-${process.pid}-${randomUUID()}.tmp`; const data=Buffer.from(content,"utf8");
 try { await writeFile(tmp,data,{flag:"wx"}); await rename(tmp,guard.absolutePath!); } catch(e) { await rm(tmp,{force:true}).catch(()=>{}); throw e; }
 const after=await readFile(guard.absolutePath!); const after_sha256=sha256Hex(after);
 return {ok:true,path,created:!existed,overwritten:existed,bytes:after.length,before_sha256,after_sha256,atomic_write:true,evidence_receipts:fileToolEvidenceReceipt({ toolName: "write_file", summary: `${existed?"Overwrote":"Created"} workspace file ${path}`, references: {path,created:!existed,overwritten:existed,before_sha256,after_sha256,atomic_write:true}, satisfies: ["durable_artifact"] })};
}
