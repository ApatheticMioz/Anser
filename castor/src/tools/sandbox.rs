//! 5-layer path containment policy, ported from
//! `mcp-castor/src/harness/services/sandbox_fs.js`.
//!
//! Layers (each a `pub fn` returning `Result<PathBuf, SandboxError>`):
//! 1. `resolve_workspace_root` — canonicalize the workspace root
//! 2. `verify_symlink_containment` — refuse symlink escapes
//! 3. `refuse_out_of_tree` — refuse absolute out-of-tree paths
//! 4. `normalize_traversal` — lexical normalization + traversal refusal
//! 5. `check_binary` — magic-number sniff → `BinaryFile` fail-fast
//!
//! The workspace root is always a `&Path` argument: no config, no env, no
//! globals. Errors are typed and carry verbatim refusal messages; nothing is
//! silently coerced.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SandboxError {
    #[error("{0}")]
    InvalidPath(String),
    #[error("{0}")]
    NullByte(String),
    #[error("{0}")]
    DeviceName(String),
    #[error("{0}")]
    PathEscape(String),
    #[error("{0}")]
    SymlinkEscape(String),
    #[error("{0}")]
    WorkspaceRoot(String),
    #[error(
        "BinaryFileError: '{file}' is a binary file ({detected_type}); reason: {reason}. \
         A text-only model must not ingest binary content. Do NOT read this file as text. \
         To extract its text, use the bash tool with a format-appropriate extractor \
         (e.g. 'pdftotext file -' for PDF, 'strings file', 'exiftool file', 'unzip -l file') \
         and read the extracted text output instead."
    )]
    BinaryFile {
        file: PathBuf,
        detected_type: String,
        reason: String,
    },
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// Layer 1: resolve the workspace root through the OS symlink/junction
/// resolution layer so containment checks compare against a real path.
pub fn resolve_workspace_root(root: &Path) -> Result<PathBuf, SandboxError> {
    let meta = fs::metadata(root).map_err(|_| {
        SandboxError::WorkspaceRoot(format!(
            "WorkspaceRootError: workspace root '{}' does not exist or is not a directory",
            root.display()
        ))
    })?;
    if !meta.is_dir() {
        return Err(SandboxError::WorkspaceRoot(format!(
            "WorkspaceRootError: workspace root '{}' is not a directory",
            root.display()
        )));
    }
    fs::canonicalize(root).map_err(|e| {
        SandboxError::WorkspaceRoot(format!(
            "WorkspaceRootError: cannot canonicalize workspace root '{}': {e}",
            root.display()
        ))
    })
}

fn is_within(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root).is_ok()
}

/// Layer 2: refuse symlink escapes. An existing target must canonicalize
/// inside the root; a non-existent target's nearest existing ancestor must
/// canonicalize inside the root.
pub fn verify_symlink_containment(target: &Path, root: &Path) -> Result<PathBuf, SandboxError> {
    if target.exists() {
        let real = fs::canonicalize(target)?;
        if !is_within(&real, root) {
            return Err(SandboxError::SymlinkEscape(format!(
                "SymlinkEscapeError: Real path '{}' escapes sandbox root '{}'",
                real.display(),
                root.display()
            )));
        }
        return Ok(target.to_path_buf());
    }
    let mut parent = target.parent().map(Path::to_path_buf);
    while let Some(p) = parent {
        let above = p.parent().map(Path::to_path_buf);
        if above.as_ref() == Some(&p) {
            break;
        }
        if p.exists() {
            let real = fs::canonicalize(&p)?;
            if !is_within(&real, root) {
                return Err(SandboxError::SymlinkEscape(format!(
                    "SymlinkEscapeError: Parent directory '{}' resolves to '{}' escaping root '{}'",
                    p.display(),
                    real.display(),
                    root.display()
                )));
            }
            break;
        }
        parent = above;
    }
    Ok(target.to_path_buf())
}

/// Layer 3: refuse absolute paths that do not land inside the workspace root.
pub fn refuse_out_of_tree(root: &Path, target: &Path) -> Result<PathBuf, SandboxError> {
    if target.is_absolute() && !is_within(target, root) {
        return Err(SandboxError::PathEscape(format!(
            "PathEscapeError: Access denied. Path '{}' escapes sandbox root '{}'",
            target.display(),
            root.display()
        )));
    }
    Ok(target.to_path_buf())
}

/// Lexically collapse `.` and `..` components without touching the filesystem.
fn normalize_lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn is_reserved_device(name: &str) -> bool {
    let upper = name.to_uppercase();
    let stem = upper.split('.').next().unwrap_or("");
    if matches!(stem, "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    for prefix in ["COM", "LPT"] {
        if let Some(rest) = stem.strip_prefix(prefix) {
            if let Some(d) = rest.chars().next() {
                if rest.len() == 1 && d.is_ascii_digit() {
                    return true;
                }
            }
        }
    }
    false
}

/// Layer 4: normalize a raw path string (null-byte and reserved-device
/// refusal, backslash normalization, relative resolution against the root,
/// lexical `..` collapse) and refuse any result that lands outside the root.
pub fn normalize_traversal(root: &Path, input: &str) -> Result<PathBuf, SandboxError> {
    if input.contains('\0') {
        return Err(SandboxError::NullByte(
            "NullByteError: Path contains prohibited null byte character".into(),
        ));
    }
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Ok(root.to_path_buf());
    }
    let posix = trimmed.replace('\\', "/");
    let base_name = posix.rsplit('/').next().unwrap_or("");
    if is_reserved_device(base_name) {
        return Err(SandboxError::DeviceName(format!(
            "DeviceNameError: Prohibited access to Windows reserved device '{}'",
            base_name.to_uppercase()
        )));
    }
    let p = if posix.starts_with('/') {
        PathBuf::from(posix)
    } else {
        root.join(&posix)
    };
    let normalized = normalize_lexical(&p);
    if !is_within(&normalized, root) {
        return Err(SandboxError::PathEscape(format!(
            "PathEscapeError: Access denied. Path '{}' escapes sandbox root '{}'",
            input,
            root.display()
        )));
    }
    Ok(normalized)
}

/// Magic-number signatures: (prefix bytes, mime, label).
const MAGIC_SIGNATURES: &[(&[u8], &str, &str)] = &[
    (b"%PDF-", "application/pdf", "PDF"),
    (&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A], "image/png", "PNG"),
    (&[0xFF, 0xD8, 0xFF], "image/jpeg", "JPEG"),
    (b"GIF8", "image/gif", "GIF"),
    (b"PK\x03\x04", "application/zip", "ZIP"),
    (&[0x1F, 0x8B], "application/gzip", "GZIP"),
    (&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C], "application/x-7z", "7z"),
    (b"BZh", "application/x-bzip2", "bzip2"),
    (&[0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00], "application/x-xz", "xz"),
    (b"\x7FELF", "application/x-elf", "ELF"),
    (b"MZ", "application/x-dosexec", "PE/COFF"),
    (b"ID3", "audio/mpeg", "MP3"),
    (b"SQLite format 3\x00", "application/x-sqlite3", "SQLite"),
    (b"\x00asm", "application/wasm", "WASM"),
    (b"wOF2", "font/woff2", "WOFF2"),
    (b"wOFF", "font/woff", "WOFF"),
    (b"RIFF", "audio/wav", "WAV/RIFF"),
];

fn sniff_magic(b: &[u8]) -> Option<(&'static str, &'static str)> {
    for (sig, mime, label) in MAGIC_SIGNATURES {
        if b.len() >= sig.len() && &b[..sig.len()] == *sig {
            return Some((mime, label));
        }
    }
    if b.len() >= 2 && b[0] == 0xFF && matches!(b[1], 0xFB | 0xF3 | 0xF7) {
        return Some(("audio/mpeg", "MP3"));
    }
    if b.len() >= 12 && &b[4..8] == b"ftyp" {
        return Some(("video/mp4", "MP4"));
    }
    None
}

/// Layer 5: binary read fail-fast. Sniff the first 4100 bytes; a known
/// binary signature yields `SandboxError::BinaryFile` (never coerced to text).
pub fn check_binary(path: &Path) -> Result<PathBuf, SandboxError> {
    let mut f = fs::File::open(path)?;
    let mut buf = vec![0u8; 4100];
    let n = f.read(&mut buf)?;
    buf.truncate(n);
    if let Some((mime, label)) = sniff_magic(&buf) {
        return Err(SandboxError::BinaryFile {
            file: path.to_path_buf(),
            detected_type: format!("{mime} ({label})"),
            reason: format!("magic bytes identify it as {mime}"),
        });
    }
    Ok(path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "castor_sandbox_{}_{}",
            std::process::id(),
            name
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        root
    }

    #[test]
    fn workspace_root_resolves_to_canonical() {
        let root = test_root("root_ok");
        let resolved = resolve_workspace_root(&root).unwrap();
        assert_eq!(resolved, fs::canonicalize(&root).unwrap());
    }

    #[test]
    fn workspace_root_missing_rejected() {
        let missing = std::env::temp_dir().join("castor_sandbox_missing_never");
        assert!(matches!(
            resolve_workspace_root(&missing),
            Err(SandboxError::WorkspaceRoot(_))
        ));
    }

    #[test]
    fn traversal_escape_rejected() {
        let root = test_root("traversal");
        for input in [
            "../outside.txt",
            "src/../../outside.txt",
            "a/b/../../../c",
        ] {
            let err = normalize_traversal(&root, input).unwrap_err();
            assert!(matches!(err, SandboxError::PathEscape(_)), "{input}");
        }
    }

    #[test]
    fn null_byte_rejected() {
        let root = test_root("nullbyte");
        assert!(matches!(
            normalize_traversal(&root, "a\0b"),
            Err(SandboxError::NullByte(_))
        ));
    }

    #[test]
    fn device_name_rejected() {
        let root = test_root("device");
        assert!(matches!(
            normalize_traversal(&root, "NUL"),
            Err(SandboxError::DeviceName(_))
        ));
        assert!(matches!(
            normalize_traversal(&root, "src/COM1.txt"),
            Err(SandboxError::DeviceName(_))
        ));
    }

    #[test]
    fn out_of_tree_absolute_rejected() {
        let root = test_root("outofree");
        let err = refuse_out_of_tree(&root, Path::new("/etc/passwd")).unwrap_err();
        assert!(matches!(err, SandboxError::PathEscape(_)));
    }

    #[test]
    fn in_tree_absolute_allowed() {
        let root = test_root("intree_abs");
        let target = root.join("src").join("main.rs");
        assert!(refuse_out_of_tree(&root, &target).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_rejected() {
        let root = test_root("symlink_out");
        let outside = std::env::temp_dir().join(format!(
            "castor_sandbox_outside_{}_symlink_out",
            std::process::id()
        ));
        fs::create_dir_all(&outside).unwrap();
        let outside_file = outside.join("secret.txt");
        fs::write(&outside_file, "secret").unwrap();
        let link = root.join("link_to_outside");
        std::os::unix::fs::symlink(&outside_file, &link).unwrap();
        let err = verify_symlink_containment(&link, &root).unwrap_err();
        assert!(matches!(err, SandboxError::SymlinkEscape(_)));
        let _ = fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn in_tree_symlink_allowed() {
        let root = test_root("symlink_in");
        let target = root.join("src").join("main.rs");
        fs::write(&target, "fn main() {}\n").unwrap();
        let link = root.join("alias.rs");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(verify_symlink_containment(&link, &root).is_ok());
    }

    #[test]
    fn binary_magic_fail_fast() {
        let root = test_root("binary");
        let png = root.join("img.png");
        fs::write(
            &png,
            [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0],
        )
        .unwrap();
        let err = check_binary(&png).unwrap_err();
        match &err {
            SandboxError::BinaryFile {
                detected_type,
                reason,
                ..
            } => {
                assert!(detected_type.contains("image/png"));
                assert!(reason.contains("magic bytes"));
            }
            other => panic!("expected BinaryFile, got {other:?}"),
        }
    }

    #[test]
    fn text_file_passes_binary_check() {
        let root = test_root("text");
        let txt = root.join("notes.txt");
        fs::write(&txt, "hello world\n").unwrap();
        assert!(check_binary(&txt).is_ok());
    }

    #[test]
    fn legit_in_tree_paths_pass() {
        let root = test_root("legit");
        let resolved = normalize_traversal(&root, "src/main.rs").unwrap();
        assert_eq!(resolved, root.join("src").join("main.rs"));
        let resolved = normalize_traversal(&root, "./src/../src/main.rs").unwrap();
        assert_eq!(resolved, root.join("src").join("main.rs"));
    }
}
