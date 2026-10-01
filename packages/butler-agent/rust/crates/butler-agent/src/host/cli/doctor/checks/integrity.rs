//! Read-only verification against the hashes in the installed native manifest.

use std::path::Path;

use butler_runtime::operations::{sha256_file, sha256_tree};
use serde_json::json;

use super::{Check, ResolvedInstallation};

pub(crate) fn digest_check(installation: &ResolvedInstallation) -> Check {
    let result = installation.payload_provenance();
    let (status, summary, evidence) = match result {
        Err(_) => (
            "fail",
            "installed manifest could not be verified",
            json!({"verified": false, "reason": "manifest_unavailable"}),
        ),
        Ok(None) => (
            "warn",
            "installed manifest has no integrity baseline",
            json!({"verified": false, "reason": "manifest_missing"}),
        ),
        Ok(Some(provenance)) => match (
            provenance.binary_sha256.as_deref(),
            provenance.resources_sha256.as_deref(),
        ) {
            (Some(expected_binary), Some(expected_resources)) => {
                let binary = hash_file(installation.executable());
                let resources = hash_tree(installation.resources());
                match (binary, resources) {
                    (Ok(actual_binary), Ok(actual_resources)) => {
                        let binary_matches = actual_binary.eq_ignore_ascii_case(expected_binary);
                        let resources_match =
                            actual_resources.eq_ignore_ascii_case(expected_resources);
                        let matches = binary_matches && resources_match;
                        (
                            if matches { "pass" } else { "fail" },
                            if matches {
                                "installed executable and resources match their recorded hashes"
                            } else {
                                "installed executable or resources differ from their recorded hashes"
                            },
                            json!({
                                "verified": true,
                                "binaryMatches": binary_matches,
                                "resourcesMatch": resources_match,
                                "expectedBinarySha256": expected_binary,
                                "actualBinarySha256": actual_binary,
                                "expectedResourcesSha256": expected_resources,
                                "actualResourcesSha256": actual_resources
                            }),
                        )
                    }
                    _ => (
                        "fail",
                        "installed executable or resources could not be hashed safely",
                        json!({"verified": false, "reason": "payload_unreadable"}),
                    ),
                }
            }
            _ => (
                "warn",
                "installed manifest does not record executable and resource hashes",
                json!({"verified": false, "reason": "hashes_unavailable"}),
            ),
        },
    };
    Check {
        id: "integrity",
        status,
        summary,
        evidence,
    }
}

fn hash_file(path: &Path) -> Result<String, &'static str> {
    sha256_file(path).map_err(|_| "payload_unreadable")
}

fn hash_tree(root: &Path) -> Result<String, &'static str> {
    sha256_tree(root).map_err(|_| "payload_unreadable")
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::hash_tree;

    /// Format pin: the install tree digest equals the standalone packager's
    /// encoding (another program writes it).
    // test-category: format-pin
    #[test]
    fn tree_digest_matches_standalone_packager_encoding() {
        let temporary = TempDirectory::new();
        fs::create_dir(temporary.0.join("sub")).expect("subdirectory");
        fs::write(temporary.0.join("a.txt"), b"a").expect("file a");
        fs::write(temporary.0.join("sub/b.txt"), b"bc").expect("file b");
        assert_eq!(
            hash_tree(&temporary.0).expect("hash tree"),
            "f46ca8db3249930759623a470fe7d62e5508ddab74dee9d534cb1a2adbe469ac"
        );
    }

    struct TempDirectory(PathBuf);

    impl TempDirectory {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "butler-doctor-integrity-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("create temporary test directory");
            Self(path)
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}
