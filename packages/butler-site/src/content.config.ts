import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { SECTION_IDS } from "./site/sections";

/**
 * Docs pages per locale: src/content/docs/<locale>/<section>/<page>.mdx.
 * `planned` pages show as disabled sidebar rows and are never built; any
 * draft body stays unpublished until the status flips to `published`.
 */
const docs = defineCollection({
  loader: glob({ pattern: "**/*.mdx", base: "./src/content/docs" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    section: z.enum(SECTION_IDS),
    order: z.number().int(),
    status: z.enum(["published", "planned"]),
  }),
});

export const collections = { docs };
