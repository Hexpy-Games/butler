//! Dev-only end-to-end harness for Butler.
//!
//! The system under test is the real `butler-agent` executable. The harness
//! starts it with an isolated data dir and free ports, and drives it only
//! through its public surface: gateway HTTP, the CLI, process signals and the
//! data dir on disk. Model traffic goes to a record/replay provider that serves
//! sanitized recordings of real provider traffic (see `e2e::stub`).
//!
//! Scenarios live in `tests/`; the catalog and rules are in `README.md`.

pub mod e2e;
