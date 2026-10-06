export function closedRoots(session: { sendCommand(method: string, params?: object): Promise<unknown> }, frameId: string, mainFrameId?: string): Promise<{contextId:number;hasClosedRoots:boolean}>;
