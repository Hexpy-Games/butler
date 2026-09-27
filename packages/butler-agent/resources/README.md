# resources

`resources/` contains product assets shipped beside the native executable:
prompts, persona templates, templates, and bundled skills.

## Key Areas

- `prompts/`: core Butler, Steward, and Worker prompt material.
- `personas/templates/{en,ko}/`: persona presets localized by
  user language.
- `skills/`: bundled strategy skills.
- `templates/`: generated user-facing template sources.
- `eol.md`: bundled baseline operating guidance.

## Boundaries

Resources are product defaults. User-personalized copies and private runtime
state belong under `BUTLER_DATA`, not in the repository checkout.

## Related Specs

- `SPEC-NATIVE-PRODUCT` - Native Butler Product
- `SPEC-BUTLER-EXPERIENCE-POLISH` - Butler Experience Polish
- `SPEC-AUTONOMOUS-SKILL-SYSTEM` - Autonomous Skill System
