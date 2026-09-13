export function memorySourceHandle(generationId: string, sourceId: string): string {
  return `memory-source:v2:${
    Buffer.from(generationId, "utf8").toString("base64url")
  }:${Buffer.from(sourceId, "utf8").toString("base64url")}`;
}

export function rawMemorySourceId(sourceRef: string): string {
  const parts = sourceRef.split(":");
  return parts.length === 4 && parts[0] === "memory-source" && parts[1] === "v2"
    ? Buffer.from(parts[3]!, "base64url").toString("utf8")
    : sourceRef;
}
