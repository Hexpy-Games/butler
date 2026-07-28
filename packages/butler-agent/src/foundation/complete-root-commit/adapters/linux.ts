import { dlopen, FFIType, ptr } from "bun:ffi";
import type { CompleteRootCommitAdapter } from "../contracts.ts";

export const linuxCompleteRootCommit: CompleteRootCommitAdapter = {
  reconcileExchange: () => false,
  exchange(left, right) {
    rename(left, right, 2);
  },
  install(source, target) {
    rename(source, target, 1);
  },
};

function rename(left: string, right: string, flags: number): void {
  const library = dlopen("libc.so.6", {
    renameat2: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
  });
  try {
    const leftPath = Buffer.from(`${left}\0`);
    const rightPath = Buffer.from(`${right}\0`);
    const result = library.symbols.renameat2(
      -100,
      ptr(leftPath),
      -100,
      ptr(rightPath),
      flags,
    );
    if (result !== 0) throw new Error("Complete-root commit failed");
  } finally {
    library.close();
  }
}
