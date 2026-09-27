/** Every progressive enhancement the docs pages use, run once per page. */
import { enhanceCodeFrames } from "../../components/CodeFrame/codeFrame.client";
import { enhanceTabs } from "../../components/Tabs/tabs.client";
import { observeAllScrollEdges } from "../../lib/scrollEdges";
import { enhanceDrawer } from "./drawer";
import { labelModifierKeys, trackScrolled, trackTocHeading } from "./pageChrome";
import { enhanceSearch } from "./search";
import { enhanceThemeToggles } from "./theme";

enhanceThemeToggles();
enhanceTabs();
enhanceCodeFrames();
observeAllScrollEdges();
enhanceDrawer();
enhanceSearch();
trackScrolled();
trackTocHeading();
labelModifierKeys();
