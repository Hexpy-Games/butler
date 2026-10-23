import { CanonBoard } from "../canon/CanonBoard.tsx";
export function ProjectWorkBoard({ projectId, onOpenSession, bottomInset }: {
  bottomInset?: number; projectId: string; onOpenSession: (id: string) => void;
}) {
  return <CanonBoard key={projectId} projectId={projectId} bottomInset={bottomInset} onOpenSession={onOpenSession} />;
}
