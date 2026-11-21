//! Check whether another process's memory is readable.

use std::io;

/// Reads one byte of the first readable mapping when Linux permits access.
#[cfg(target_os = "linux")]
pub fn memory_readable(pid: u32) -> io::Result<bool> {
    use std::fs::{File, read_to_string};
    use std::io::{Read, Seek, SeekFrom};

    let read = || -> io::Result<()> {
        let mut mem = File::open(format!("/proc/{pid}/mem"))?;
        let maps = read_to_string(format!("/proc/{pid}/maps"))?;
        let start = maps
            .lines()
            .find_map(|line| {
                let mut fields = line.split_whitespace();
                let range = fields.next()?;
                fields.next()?.starts_with('r').then_some(range)
            })
            .and_then(|range| range.split_once('-'))
            .and_then(|(start, _)| u64::from_str_radix(start, 16).ok())
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "No readable mapping"))?;
        mem.seek(SeekFrom::Start(start))?;
        mem.read_exact(&mut [0])
    };
    match read() {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => Ok(false),
        Err(error) => Err(error),
    }
}

/// The process memory probe requires Linux procfs.
#[cfg(not(target_os = "linux"))]
pub fn memory_readable(_pid: u32) -> io::Result<bool> {
    Err(io::ErrorKind::Unsupported.into())
}
