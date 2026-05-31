# resources

`resources/` contains product assets that are loaded or copied by the installer
and runtime: prompts, persona templates, runtime pins, templates, and bundled
skills.

## Key Areas

- `prompts/`: core Butler, Steward, and Worker prompt material.
- `personas/templates/{en,ko}/`: install-time persona presets localized by
  user language.
- `skills/`: bundled strategy skills.
- `templates/`: generated user-facing template sources.
- `runtime/bun-version`: pinned Butler-managed runtime version.
- `eol.md`: bundled baseline operating guidance copied during setup.

## Boundaries

Resources are product defaults. User-personalized copies and private runtime
state belong under `BUTLER_DATA`, not in the repository checkout.

## Related Specs

- `SPEC-NATIVE-PRODUCT` - Native Butler Product
- `SPEC-BUTLER-EXPERIENCE-POLISH` - Butler Experience Polish
- `SPEC-AUTONOMOUS-SKILL-SYSTEM` - Autonomous Skill System
- `SPEC-MANAGED-BUN-RUNTIME` - Butler-Managed Bun Runtime
