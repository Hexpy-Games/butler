let mutationTail = Promise.resolve();

/** Serialize this process's native file mutations. */
export async function withButlerFileMutationLock<T>(
  action: () => Promise<T>,
): Promise<T> {
  const previous = mutationTail;
  let release = () => {};
  const ticket = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => ticket);
  mutationTail = tail;
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (mutationTail === tail) mutationTail = Promise.resolve();
  }
}
