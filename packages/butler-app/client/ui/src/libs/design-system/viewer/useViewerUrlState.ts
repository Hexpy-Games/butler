import { useCallback, useEffect, useState } from "react";
import { parseViewerState, viewerSearchString, type ViewerState } from "./viewerState";

/** Viewer state mirrored into `page`/`theme`/`locale`/`width` URL params. */
export function useViewerUrlState(): [ViewerState, (patch: Partial<ViewerState>) => void] {
  const [state, setState] = useState(() => parseViewerState(window.location.search));

  useEffect(() => {
    const search = viewerSearchString(window.location.search, state);
    const url = `${window.location.pathname}${search}${window.location.hash}`;
    if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, "", url);
    }
  }, [state]);

  const update = useCallback((patch: Partial<ViewerState>) => {
    setState((current) => ({ ...current, ...patch }));
  }, []);

  return [state, update];
}
