# skills integration

`packages/butler-agent/src/integrations/skills/` owns the bundled skill catalog. Skills describe reusable strategy
guidance that the model can inspect through structured discovery tools.

## Key Files

- `catalog.ts`: skill metadata loading, validation, and prompt rendering for
  model-inspected skill metadata.

## Boundaries

Skills should guide model behavior; they should not bypass tool schemas,
runtime guards, transport contracts, or task review gates.

## Related Specs

- `SPEC-AUTONOMOUS-SKILL-SYSTEM` - Autonomous Skill System
- `SPEC-AGENTIC-CORE-TOOL-CAPABILITY-DISCOVERY` - Agentic Core AC-6 Tool Capability Discovery
- `SPEC-BUTLER-AGENT-LOOP` - Butler Agent Loop
