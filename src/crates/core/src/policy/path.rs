//! Path confinement.
//!
//! Every filesystem tool resolves its argument through this module *before*
//! policy is evaluated. That ordering matters: if policy saw the raw string, a
//! crafted `..` or a symlink would let a call pass a rule written for a
//! different directory.
//!
//! Two independent checks run on every path:
//!
//! 1. **Containment** — the canonicalised path must sit inside a configured
//!    root. This is what stops `../../etc/passwd` and symlinks that point out
//!    of the sandbox.
//! 2. **Denylist** — even inside a root, a small set of names is refused, so
//!    pointing a root at `$HOME` does not silently expose private keys.

use std::path::{Component, Path, PathBuf};

use crate::error::{BridgeError, Result};

/// Names refused even when they live inside an allowed root.
///
/// This is a defence-in-depth layer, not the primary boundary. It exists
/// because users routinely point a root at their home directory, and the model
/// is very willing to read `.env` and `id_rsa` when asked to "find the config".
const DENIED_FILE_NAMES: &[&str] = &[
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "shadow",
    "master.key",
];

/// File extensions refused outright.
const DENIED_EXTENSIONS: &[&str] = &["pem", "key", "pfx", "p12", "keystore", "jks"];

/// Directory names that are never traversed.
const DENIED_DIR_NAMES: &[&str] = &[".ssh", ".gnupg", ".aws", ".azure", ".kube"];

/// A set of directories the bridge is permitted to touch.
#[derive(Debug, Clone, Default)]
pub struct PathSandbox {
    roots: Vec<PathBuf>,
}

/// Canonicalises the existing portion of a path while preserving nonexistent
/// trailing components. This keeps containment checks useful for write targets
/// without losing symlink-aware comparisons on platforms such as macOS.
fn canonicalize_for_comparison(path: &Path) -> PathBuf {
    if let Ok(canonical) = dunce::canonicalize(path) {
        return canonical;
    }

    let mut existing = path;
    let mut suffix = Vec::new();

    while !existing.exists() {
        match existing.file_name() {
            Some(name) => suffix.push(name.to_os_string()),
            None => break,
        }
        match existing.parent() {
            Some(parent) => existing = parent,
            None => break,
        }
    }

    let mut out = dunce::canonicalize(existing)
        .unwrap_or_else(|_| lexical_normalize(existing));
    for component in suffix.iter().rev() {
        out.push(component);
    }
    lexical_normalize(&out)
}

impl PathSandbox {
    pub fn new(roots: impl IntoIterator<Item = PathBuf>) -> Self {
        // Canonicalise eagerly so a root that does not exist yet (or is given
        // as a relative path) cannot silently widen the sandbox later.
        let roots = roots
            .into_iter()
            .filter_map(|root| canonicalize_root(&root))
            .collect();
        Self { roots }
    }

    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    pub fn is_empty(&self) -> bool {
        self.roots.is_empty()
    }

    /// Resolves a user-supplied path and proves it is inside a root.
    ///
    /// `must_exist` is false for write targets, where the file legitimately does
    /// not exist yet: in that case the *parent* directory is canonicalised and
    /// checked instead, which is what actually constrains where bytes can land.
    pub fn resolve(&self, raw: &str, must_exist: bool) -> Result<PathBuf> {
        if raw.trim().is_empty() {
            return Err(BridgeError::invalid_params("`path` must not be empty"));
        }

        let candidate = expand_user(raw);
        let absolute = if candidate.is_absolute() {
            candidate
        } else {
            // Relative paths resolve against the first root, which gives the
            // model a predictable "current directory" without the host having a
            // process-wide cwd that changes under it.
            let base = self.roots.first().ok_or_else(|| {
                BridgeError::path_not_allowed(
                    "No workspace root is configured; set one in the bridge settings",
                )
            })?;
            base.join(candidate)
        };

        let canonical = if must_exist {
            dunce::canonicalize(&absolute).map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    BridgeError::invalid_params(format!(
                        "Path does not exist: {}",
                        absolute.display()
                    ))
                } else {
                    BridgeError::from_io("Failed to resolve path", error)
                }
            })?
        } else {
            let parent = absolute.parent().ok_or_else(|| {
                BridgeError::invalid_params(format!("Path has no parent: {}", absolute.display()))
            })?;
            let parent = dunce::canonicalize(parent).map_err(|error| {
                BridgeError::invalid_params(format!(
                    "Parent directory does not exist: {} ({error})",
                    parent.display()
                ))
            })?;
            match absolute.file_name() {
                Some(name) => parent.join(name),
                None => parent,
            }
        };

        self.assert_contained(&canonical)?;
        self.assert_not_denied(&canonical)?;
        Ok(canonical)
    }

    /// Checks containment using the canonical location of the existing portion
    /// of the path.
    ///
    /// This handles platforms such as macOS where a system temporary-directory
    /// path can contain a symlink (for example `/var` -> `/private/var`). For a
    /// path that does not exist yet, only its deepest existing ancestor is
    /// canonicalised and the remaining components are appended lexically.
    pub fn assert_contained(&self, path: &Path) -> Result<()> {
        if self.roots.is_empty() {
            return Err(BridgeError::path_not_allowed(
                "No workspace root is configured; set one in the bridge settings",
            ));
        }
        let normalised = canonicalize_for_comparison(path);

        let allowed = self.roots.iter().any(|root| normalised.starts_with(root));
        if allowed {
            return Ok(());
        }

        Err(BridgeError::path_not_allowed(format!(
            "Path is outside the allowed workspace: {}",
            path.display()
        ))
        .with_data(serde_json::json!({
            "path": path.display().to_string(),
            "roots": self.roots.iter().map(|r| r.display().to_string()).collect::<Vec<_>>(),
        })))
    }

    fn assert_not_denied(&self, path: &Path) -> Result<()> {
        for component in path.components() {
            let Component::Normal(name) = component else {
                continue;
            };
            let name = name.to_string_lossy();
            let lowered = name.to_ascii_lowercase();

            if DENIED_DIR_NAMES.iter().any(|d| lowered == *d) {
                return Err(BridgeError::path_not_allowed(format!(
                    "Access to `{name}` directories is blocked by the host denylist"
                )));
            }
            if DENIED_FILE_NAMES.iter().any(|d| lowered == *d) {
                return Err(BridgeError::path_not_allowed(format!(
                    "Access to `{name}` is blocked by the host denylist"
                )));
            }
            if lowered == ".env" || lowered.starts_with(".env.") {
                return Err(BridgeError::path_not_allowed(
                    "Access to `.env` files is blocked by the host denylist",
                ));
            }
        }

        if let Some(extension) = path.extension().and_then(|e| e.to_str()) {
            let lowered = extension.to_ascii_lowercase();
            if DENIED_EXTENSIONS.iter().any(|e| lowered == *e) {
                return Err(BridgeError::path_not_allowed(format!(
                    "Access to `.{lowered}` files is blocked by the host denylist"
                )));
            }
        }

        Ok(())
    }
}

/// Expands a leading `~` into the user's home directory.
fn expand_user(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if trimmed == "~" {
        if let Some(home) = home_dir() {
            return home;
        }
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(trimmed)
}

fn home_dir() -> Option<PathBuf> {
    directories::UserDirs::new().map(|dirs| dirs.home_dir().to_path_buf())
}

/// Canonicalises a configured root, falling back to a lexical normalisation
/// when the directory does not exist yet.
fn canonicalize_root(root: &Path) -> Option<PathBuf> {
    let expanded = expand_user(&root.to_string_lossy());
    match dunce::canonicalize(&expanded) {
        Ok(path) => Some(path),
        Err(_) => {
            if expanded.is_absolute() {
                Some(lexical_normalize(&expanded))
            } else {
                None
            }
        }
    }
}

/// Removes `.` and resolves `..` without touching the filesystem.
///
/// `Path::canonicalize` requires the path to exist; this is the fallback for
/// write targets and for comparing against roots.
pub fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                // Never pop past the root: `/..` is `/`.
                if !out.pop() {
                    out.push(Component::RootDir.as_os_str());
                }
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Creates a unique, real directory so canonicalisation has something to
    /// resolve. These tests must use real paths: a synthetic `/tmp/...` string
    /// is not absolute on Windows, which silently turns the assertions vacuous.
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(label: &str) -> Self {
            use std::sync::atomic::{AtomicU32, Ordering};
            static COUNTER: AtomicU32 = AtomicU32::new(0);

            let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("dlb-test-{label}-{}-{unique}", std::process::id()));
            std::fs::create_dir_all(&path).expect("failed to create temp dir");
            Self { path }
        }

        fn join(&self, relative: &str) -> PathBuf {
            self.path.join(relative)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn lexical_normalize_resolves_parent_segments() {
        assert_eq!(
            lexical_normalize(Path::new("/a/b/../c")),
            PathBuf::from("/a/c")
        );
    }

    #[test]
    fn lexical_normalize_never_escapes_root() {
        assert_eq!(lexical_normalize(Path::new("/../..")), PathBuf::from("/"));
    }

    #[test]
    fn containment_accepts_paths_inside_the_root() {
        let workspace = TempDir::new("inside");
        let sandbox = PathSandbox::new([workspace.path.clone()]);
        assert!(
            sandbox
                .assert_contained(&workspace.join("file.txt"))
                .is_ok()
        );
        assert!(
            sandbox
                .assert_contained(&workspace.join("a/b/c.txt"))
                .is_ok()
        );
    }

    #[test]
    fn containment_rejects_sibling_directory() {
        let workspace = TempDir::new("sibling");
        let sandbox = PathSandbox::new([workspace.path.clone()]);

        // The classic prefix-confusion bug: a sibling directory whose name
        // merely *starts with* the root must not be accepted.
        let sibling = PathBuf::from(format!("{}-evil", workspace.path.display()));
        assert!(sandbox.assert_contained(&sibling.join("x")).is_err());
    }

    #[test]
    fn containment_rejects_traversal() {
        let workspace = TempDir::new("traversal");
        let sandbox = PathSandbox::new([workspace.path.clone()]);
        assert!(
            sandbox
                .assert_contained(&workspace.join("../../etc/passwd"))
                .is_err()
        );
        assert!(
            sandbox
                .assert_contained(&workspace.join("..").join("escape"))
                .is_err()
        );
    }

    #[test]
    fn empty_sandbox_rejects_everything() {
        let sandbox = PathSandbox::default();
        assert!(sandbox.is_empty());
        assert!(
            sandbox
                .assert_contained(Path::new("/tmp/anything"))
                .is_err()
        );
    }

    #[test]
    fn resolve_reads_a_real_file_inside_the_root() {
        let workspace = TempDir::new("resolve-ok");
        std::fs::write(workspace.join("hello.txt"), "hi").unwrap();

        let sandbox = PathSandbox::new([workspace.path.clone()]);
        let resolved = sandbox
            .resolve(workspace.join("hello.txt").to_str().unwrap(), true)
            .expect("a real file inside the root must resolve");
        assert!(resolved.ends_with("hello.txt"));
    }

    #[test]
    fn denylist_blocks_ssh_keys_inside_a_root() {
        let workspace = TempDir::new("ssh");
        // Create the file for real, so this test exercises the denylist rather
        // than failing earlier on a missing path.
        std::fs::create_dir_all(workspace.join(".ssh")).unwrap();
        std::fs::write(workspace.join(".ssh/id_rsa"), "PRIVATE KEY").unwrap();

        let sandbox = PathSandbox::new([workspace.path.clone()]);
        let error = sandbox
            .resolve(workspace.join(".ssh/id_rsa").to_str().unwrap(), true)
            .unwrap_err();
        assert_eq!(error.code, crate::error::code::PATH_NOT_ALLOWED);
    }

    #[test]
    fn denylist_blocks_dotenv() {
        let workspace = TempDir::new("dotenv");
        std::fs::write(workspace.join(".env"), "SECRET=1").unwrap();

        let sandbox = PathSandbox::new([workspace.path.clone()]);
        let error = sandbox
            .resolve(workspace.join(".env").to_str().unwrap(), true)
            .unwrap_err();
        assert_eq!(error.code, crate::error::code::PATH_NOT_ALLOWED);
    }

    #[test]
    fn denylist_blocks_private_key_extensions() {
        let workspace = TempDir::new("pem");
        std::fs::write(workspace.join("server.pem"), "-----BEGIN").unwrap();

        let sandbox = PathSandbox::new([workspace.path.clone()]);
        let error = sandbox
            .resolve(workspace.join("server.pem").to_str().unwrap(), true)
            .unwrap_err();
        assert_eq!(error.code, crate::error::code::PATH_NOT_ALLOWED);
    }

    #[test]
    fn resolve_allows_a_write_target_that_does_not_exist_yet() {
        let workspace = TempDir::new("write-target");
        let sandbox = PathSandbox::new([workspace.path.clone()]);

        let resolved = sandbox
            .resolve(workspace.join("new-file.txt").to_str().unwrap(), false)
            .expect("a not-yet-existing file inside the root must resolve");
        assert!(resolved.ends_with("new-file.txt"));
    }

    #[test]
    fn resolve_rejects_a_write_target_outside_the_root() {
        let workspace = TempDir::new("write-escape");
        let sandbox = PathSandbox::new([workspace.path.clone()]);

        let outside = std::env::temp_dir().join("dlb-escape-target.txt");
        let error = sandbox
            .resolve(outside.to_str().unwrap(), false)
            .unwrap_err();
        assert_eq!(error.code, crate::error::code::PATH_NOT_ALLOWED);
    }

    #[test]
    fn resolve_rejects_relative_path_without_a_root() {
        let sandbox = PathSandbox::default();
        assert!(sandbox.resolve("relative.txt", false).is_err());
    }

    #[test]
    fn resolve_rejects_an_empty_path() {
        let workspace = TempDir::new("empty-path");
        let sandbox = PathSandbox::new([workspace.path.clone()]);
        assert!(sandbox.resolve("   ", false).is_err());
    }
}
