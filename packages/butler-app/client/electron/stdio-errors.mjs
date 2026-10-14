// Install before Electron loads: its IPC error reporter writes through console.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") throw error;
    // Console retains these stream objects. Disable only the failed destination,
    // including callbacks, rather than suppressing unrelated uncaught errors.
    stream.write = (_chunk, encoding, callback) => {
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") queueMicrotask(() => done());
      return true;
    };
  });
}
