import tokensCss from "../../tokens.css?raw";
import { buildTokenCatalog, parseTokenDefinitions } from "./tokenCatalog";

/** Parsed at build time from tokens.css (Vite ?raw); the viewer never hand-lists tokens. */
export const tokenDefinitions = parseTokenDefinitions(tokensCss);
export const tokenCatalog = buildTokenCatalog(tokenDefinitions);
