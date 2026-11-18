//! SemVer ordering shared by updates and installed versions.

/// Whether a valid release version is newer; invalid versions are never offered.
pub fn version_newer(available: &str, current: &str) -> bool {
    match (
        semver::Version::parse(available),
        semver::Version::parse(current),
    ) {
        (Ok(available), Ok(current)) => available.cmp_precedence(&current).is_gt(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::version_newer;
    use butler_platform::store_update::app_version;

    // test-category: pure-logic
    #[test]
    fn compares_source_version_segments() {
        assert!(version_newer("1.2.1", "1.2.0"));
        assert!(!version_newer("1.2.0", "1.2.0"));
        assert!(!version_newer("1.1.9", "1.2.0"));
        assert!(version_newer("0.1.0-preview.10", "0.1.0-preview.9"));
        assert!(version_newer("0.1.0", "0.1.0-preview.99"));
        assert!(!version_newer("0.1.0-preview.99", "0.1.0"));
        assert!(!version_newer("invalid", "0.1.0"));
        assert_eq!(app_version(1, 1, 17).as_deref(), Some("0.1.0-preview.17"));
        assert_eq!(app_version(1, 1, 999).as_deref(), Some("0.1.0"));
        assert_eq!(app_version(1, 1, 1001).as_deref(), Some("0.1.1-preview.1"));
        assert!(version_newer(
            &app_version(1, 1, 999).unwrap(),
            &app_version(1, 1, 17).unwrap()
        ));
        assert!(version_newer(
            &app_version(1, 1, 1001).unwrap(),
            &app_version(1, 1, 999).unwrap()
        ));
        assert_eq!(app_version(0, 1, 999), None);
    }
}
