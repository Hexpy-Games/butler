import { dlopen, FFIType, ptr } from "bun:ffi";
import type { CompleteRootCommitAdapter } from "../contracts.ts";

export const darwinCompleteRootCommit: CompleteRootCommitAdapter = {
  reconcileExchange: () => false,
  exchange(left, right) {
    rename(left, right, 2);
  },
  install(source, target) {
    rename(source, target, 4);
  },
};

function rename(left: string, right: string, flags: number): void {
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    renameatx_np: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
  });
  try {
    const leftPath = Buffer.from(`${left}\0`);
    const rightPath = Buffer.from(`${right}\0`);
    const result = library.symbols.renameatx_np(
      -2,
      ptr(leftPath),
      -2,
      ptr(rightPath),
      flags,
    );
    if (result !== 0) throw new Error("Complete-root commit failed");
  } finally {
    library.close();
  }
}
