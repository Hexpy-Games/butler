# Repo Tools

`tools/` contains repository-wide development tools that are not owned by a
single product package.

## Module Map

- `validation/`: aggregate validation runner.

## Boundaries

Tools can orchestrate multiple packages, but product runtime entrypoints and
package-specific checks belong inside the owning package.

## Related Specs

- `SPEC-OPERATIONAL-RELIABILITY` - Operational Reliability
