//! E2E fixture failure points for real filesystem requests. Without the
//! `e2e-fixtures` feature every point is inert.

#[cfg(feature = "e2e-fixtures")]
mod fixtures;
#[cfg(feature = "e2e-fixtures")]
pub(crate) use fixtures::FixtureInput;

use std::{
    fs::File,
    io::{self, Write},
};

/// Writes one buffer, then injects a failure at `point` in explicitly selected stub tests.
pub fn write(file: &mut File, bytes: &[u8], point: &str) -> io::Result<()> {
    file.write_all(bytes)?;
    checkpoint(point)
}

/// A fault-build interruption at the requested durable boundary.
pub fn checkpoint(point: &str) -> io::Result<()> {
    #[cfg(feature = "e2e-fixtures")]
    return fixtures::checkpoint(point);
    #[cfg(not(feature = "e2e-fixtures"))]
    {
        let _ = point;
        Ok(())
    }
}
/// Interrupts a fault build at the selected boundary.
pub fn abort_point(point: &str) {
    #[cfg(feature = "e2e-fixtures")]
    fixtures::abort_point(point);
    #[cfg(not(feature = "e2e-fixtures"))]
    let _ = point;
}
/// Waits at a selected fault boundary until released or stopped.
pub fn hold_point(point: &str, stopped: impl Fn() -> bool) -> io::Result<()> {
    #[cfg(feature = "e2e-fixtures")]
    return fixtures::hold_point(point, stopped);
    #[cfg(not(feature = "e2e-fixtures"))]
    {
        let _ = (point, stopped);
        Ok(())
    }
}
