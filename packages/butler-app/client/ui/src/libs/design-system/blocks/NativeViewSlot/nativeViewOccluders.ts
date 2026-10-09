/** DS overlay surfaces that paint above page content (and so under a native view). */
export const NATIVE_VIEW_OCCLUDERS = [
  '[data-slot="dialog-overlay"]', '[data-slot="dialog-content"]', '[data-slot="popover-content"]',
  '[data-slot="dropdown-menu-content"]', '[data-slot="dropdown-menu-sub-content"]', '[data-slot="context-menu-content"]',
  '[data-slot="select-content"]', '[data-slot="tooltip-content"]', "[data-sonner-toast]",
  // AdaptiveShell's peeked sidebar floats over the workspace (and so under a native view).
  '[data-left-peek="true"] > [data-slot="adaptive-shell-sidebar"]',
].join(", ");
