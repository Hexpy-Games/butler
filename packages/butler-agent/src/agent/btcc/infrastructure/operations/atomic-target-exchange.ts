import { dlopen, FFIType, ptr } from "bun:ffi";

export function exchangeCompleteTarget(left: string, right: string): void {
  if (process.platform === "darwin") {
    exchangeOnDarwin(left, right);
    return;
  }
  if (process.platform === "linux") {
    exchangeOnLinux(left, right);
    return;
  }
  throw new Error("BTCC complete-target atomic exchange is unavailable on this platform");
}

function exchangeOnDarwin(left: string, right: string): void {
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
      2,
    );
    if (result !== 0) throw new Error("BTCC atomic root exchange failed");
  } finally {
    library.close();
  }
}

function exchangeOnLinux(left: string, right: string): void {
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
      2,
    );
    if (result !== 0) throw new Error("BTCC atomic root exchange failed");
  } finally {
    library.close();
  }
}
