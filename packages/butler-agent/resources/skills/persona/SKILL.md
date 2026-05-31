---
name: persona
description: View or switch the active butler persona, or customize the active persona directly
user-invocable: true
applicability: Use when the model decides the user is asking to inspect, switch, or customize Butler's active persona or tone configuration.
allowed-tools: persona
dispatch: none
review: none
reporting: Reply directly with the active persona or applied change.
---

## Instructions

Handle persona commands directly — do not dispatch a worker.

Available presets: `butler` (default), `guardian`, `demon-butler`, `wolf-butler`, `neko-servant`, `think-tank`, `operator`, `archivist`, `dry-wit`

**Architecture:**
- Preset files (`packages/butler-agent/resources/personas/templates/{en,ko}/*.md`) are read-only templates
- The active template locale is selected from `butler.config.json` → `user.language`; currently supported locales are `en` and `ko`
- `$BUTLER_DATA/personas/active.md` is the actual applied persona — always loaded at session start
- Switching a preset copies its content into `active.md`
- `active.md` can be freely customized after copying

### Command patterns:
- "/persona" — show current active persona info and list available presets
- "/persona butler|guardian|demon-butler|wolf-butler|neko-servant|think-tank|operator|archivist|dry-wit" — switch to preset (copies to active.md)
- "/persona custom <description>" — overwrite active.md with user's custom persona

### To switch to a preset:
1. Read `$BUTLER_HOME/packages/butler-agent/resources/personas/templates/{user.language}/{name}.md` (the localized preset template), falling back to `en`
2. Copy the full content to `$BUTLER_DATA/personas/active.md`, updating the frontmatter:
   - Set `name: active`
   - Set `description: Currently active persona. Copied from preset, freely customizable.`
   - Add `base: {name}` to track which preset it came from
   - Add `base_locale: {locale}` to track which localized preset was copied
3. Update `butler.config.json` → `system.activePersona` and `system.activePersonaLocale` for reference only
4. Apply immediately in this session
5. Confirm to user with a brief example of the new tone

### To set a custom persona:
1. Take everything after "custom" as the persona description
2. Write to `$BUTLER_DATA/personas/active.md`:
   ```
   ---
   name: active
   description: Currently active persona. User custom.
   base: custom
   ---

   {user's description verbatim}
   ```
3. Update `butler.config.json` → `system.activePersona` to "custom" (for reference only)
4. Apply immediately
5. Confirm: echo back how you'll behave based on their description

### To show current:
1. Read `$BUTLER_DATA/personas/active.md`
2. Check frontmatter `base` field to show which preset it's based on
3. Report current persona + list all available presets
4. Mention that `active.md` can be directly edited for customization

Reply directly. No worker needed.
