import { createRoot } from "react-dom/client";
import { LifecycleWindowView } from "../src/components/lifecycle/LifecycleWindowView";
import "../src/libs/design-system/tokens.css";
document.documentElement.className = "theme-light";
createRoot(document.getElementById("root")!).render(<LifecycleWindowView />);
