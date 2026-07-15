import { dlopen, type Pointer } from "bun:ffi";

const jobObjectExtendedLimitInformation = 9;
const jobObjectLimitKillOnJobClose = 0x0000_2000;
const processSetQuota = 0x0100;
const processTerminate = 0x0001;
const extendedLimitInformationSizeX64 = 144;
const limitFlagsOffsetX64 = 16;

const kernel32 = dlopen("kernel32.dll", {
  CreateJobObjectW: {
    args: ["ptr", "ptr"],
    returns: "ptr",
  },
  SetInformationJobObject: {
    args: ["ptr", "u32", "ptr", "u32"],
    returns: "bool",
  },
  OpenProcess: {
    args: ["u32", "bool", "u32"],
    returns: "ptr",
  },
  AssignProcessToJobObject: {
    args: ["ptr", "ptr"],
    returns: "bool",
  },
  CloseHandle: {
    args: ["ptr"],
    returns: "bool",
  },
  GetLastError: {
    args: [],
    returns: "u32",
  },
} as const);

export type WindowsKillOnCloseJob = {
  assign(pid: number): void;
  close(): void;
};

export function createWindowsKillOnCloseJob(): WindowsKillOnCloseJob {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("The Windows Job Object PoC requires Windows x64.");
  }

  const job = kernel32.symbols.CreateJobObjectW(null, null);
  if (!job) throw windowsError("CreateJobObjectW");

  const limits = new Uint8Array(extendedLimitInformationSizeX64);
  new DataView(limits.buffer).setUint32(
    limitFlagsOffsetX64,
    jobObjectLimitKillOnJobClose,
    true,
  );
  const configured = kernel32.symbols.SetInformationJobObject(
    job,
    jobObjectExtendedLimitInformation,
    limits,
    limits.byteLength,
  );
  if (!configured) {
    const error = windowsError("SetInformationJobObject");
    kernel32.symbols.CloseHandle(job);
    throw error;
  }

  let closed = false;
  return {
    assign(pid: number): void {
      if (closed) throw new Error("Cannot assign a process to a closed Job Object.");
      const processHandle = openAssignableProcess(pid);
      try {
        if (!kernel32.symbols.AssignProcessToJobObject(job, processHandle)) {
          throw windowsError("AssignProcessToJobObject");
        }
      } finally {
        kernel32.symbols.CloseHandle(processHandle);
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (!kernel32.symbols.CloseHandle(job)) throw windowsError("CloseHandle(job)");
    },
  };
}

function openAssignableProcess(pid: number): Pointer {
  const handle = kernel32.symbols.OpenProcess(
    processSetQuota | processTerminate,
    false,
    pid,
  );
  if (!handle) throw windowsError("OpenProcess");
  return handle;
}

function windowsError(operation: string): Error {
  return new Error(`${operation} failed with Win32 error ${kernel32.symbols.GetLastError()}.`);
}
