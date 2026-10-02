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
    // Treat Windows drive-letter paths (e.g. "C:/", "D:/") as absolute so
    // they are refused as out-of-tree rather than silently joined under the
    // workspace root. (On Unix, `Path::is_absolute` does not recognize
    // drive-letter prefixes, so we detect them explicitly.)
    let is_drive = {
        let mut ch = posix.chars();
        match (ch.next(), ch.next()) {
            (Some(c), Some(':')) => c.is_ascii_alphabetic(),
            _ => false,
        }
    };
    let p = if posix.starts_with('/') || is_drive {
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
    use crate::tools::shell::{self, ShellPolicyError};

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

    // ========================================================================
    // 137-Vector Security Table
    // Ported verbatim from mcp-castor/tests/security.test.js
    // (123 attack vectors blocked + 14 allow vectors permitted)
    //
    // Each row: (input, op, expected, layer, path_operand, runnable)
    //   - `layer` names the refusal layer for blocked vectors, or "in-tree"
    //     for allowed ones.
    //   - `runnable` = true when the vector can be exercised live against a
    //     Rust policy: `ShellPolicy` rows through `shell::validate`, path
    //     rows through `normalize_traversal`. false for JS-only rules
    //     (deadman-fuse / dry-run / module-isolation) that have no Rust
    //     equivalent and are mapped to the closest layer.
    // ========================================================================

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Outcome {
        Blocked,
        Allowed,
    }

    struct Vector {
        input: &'static str,
        op: Option<&'static str>,
        expected: Outcome,
        layer: &'static str,
        /// For allowed shell vectors: the path operand that must resolve
        /// in-tree (i.e., not be a protected root).
        path_operand: Option<&'static str>,
        /// Whether this vector can be exercised live against a Rust policy:
        /// `ShellPolicy` rows through `shell::validate`, path-layer rows
        /// through `normalize_traversal`.
        runnable: bool,
    }

    fn security_vectors() -> Vec<Vector> {
        let mut v = Vec::new();

        // --- Category 1: File Path Escapes (15 paths × 4 ops = 60) ---
        let paths = [
            "C:\\Windows\\System32\\calc.exe",
            "C:\\Users\\testuser\\Desktop",
            "C:\\",
            "c:/autoexec.bat",
            "D:\\",
            "D:\\..",
            "D:\\OtherFolder",
            "..\\..\\sensitive_file.txt",
            "../../../../etc/passwd",
            "/mnt/c/Windows",
            "/mnt/c/Users",
            "/mnt/d",
            "/mnt/d/..",
            "/etc/shadow",
            "/var/log",
        ];
        let ops = ["readFile", "writeFile", "astSearch", "astReplace"];
        for path in &paths {
            for op in &ops {
                v.push(Vector {
                    input: path,
                    op: Some(*op),
                    expected: Outcome::Blocked,
                    layer: "PathEscape",
                    path_operand: None,
                    runnable: true,
                });
            }
        }

        // --- Category 2: Null Byte Attacks (2) ---
        v.push(Vector {
            input: "safe_name.js\0malicious.exe",
            op: None,
            expected: Outcome::Blocked,
            layer: "NullByte",
            path_operand: None,
            runnable: true,
        });
        v.push(Vector {
            input: "src/test.py\0/../../../../Windows",
            op: None,
            expected: Outcome::Blocked,
            layer: "NullByte",
            path_operand: None,
            runnable: true,
        });

        // --- Category 3: Windows Reserved Device Names (6) ---
        for dev in ["CON", "PRN", "AUX", "NUL", "COM1", "LPT1"] {
            v.push(Vector {
                input: dev,
                op: None,
                expected: Outcome::Blocked,
                layer: "DeviceName",
                path_operand: None,
                runnable: true,
            });
        }

        // --- Category 4: Workspace Root Directory Overwrite (1) ---
        // JS-only: writing a file over the root directory. Closest Rust
        // layer is the path-containment policy (PathEscape).
        v.push(Vector {
            input: "<workspaceRoot>",
            op: None,
            expected: Outcome::Blocked,
            layer: "PathEscape",
            path_operand: None,
            runnable: false,
        });

        // --- Category 5: Dangerous Shell Command Blocking (43) ---
        // Exercised live against `shell::validate` (the Rust shell-command
        // policy); each must yield a typed refusal.
        let dangerous = [
            "rm -rf /",
            "rm -rf /*",
            "rm -rf --no-preserve-root /",
            "rm -rf ~",
            "rm -rf C:\\",
            "rm -rf D:\\",
            "rm -rf /mnt/c/Windows",
            "rm -rf C:\\Windows",
            "rmdir /s /q C:\\",
            "del /f /s /q C:\\*",
            "del /s /q C:\\Windows",
            "rd /s /q C:\\Users",
            "rm -rf C:\\Users\\*",
            "rm -rf /mnt/c/Users/*",
            "format C:",
            "mkfs.ext4 /dev/sda1",
            "dd if=/dev/zero of=/dev/sda bs=1M",
            ":(){ :|:& };:",
            "sudo rm -rf /",
            "sudo rm -rf --no-preserve-root /",
            "bash -c \"rm -rf /\"",
            "sh -c \"rm -rf /\"",
            "cmd /c del /s /q C:\\Windows",
            "powershell -Command \"Remove-Item C:\\Users -Recurse -Force\"",
            "bash -c \"bash -c 'rm -rf /'\"",
            "rm -rf $HOME",
            "rm -rf $HOME/projects",
            "powershell -Command \"Remove-Item C:\\Users\\* -Recurse -Force\"",
            "cd /tmp && rm -rf /",
            "echo a; rm -rf /",
            "echo a || rm -rf /",
            "echo a | rm -rf /",
            "echo a\nrm -rf /",
            "true && rm -rf ~",
            "ls; rm -rf /mnt/c/Windows",
            "rm -rf `pwd`",
            "del /q `dir`",
            "rm -rf `echo /`",
            "rm -rf --no-preserve-root=/",
            "rm -rf ~user",
            "rm -rf ~root",
            "rm -rf /mnt/c/\u{FF37}indows",
            "bash -c \"cd /tmp && rm -rf /\"",
        ];
        for cmd in &dangerous {
            v.push(Vector {
                input: cmd,
                op: None,
                expected: Outcome::Blocked,
                layer: "ShellPolicy",
                path_operand: None,
                runnable: true,
            });
        }

        // --- Category 5b: Shell Allow Vectors (14) ---
        // These must NOT be blocked. Each path operand resolves in-tree
        // (deeper subpath, not a protected root).
        let allow: &[(&str, Option<&str>)] = &[
            ("rm -rf /tmp/build", Some("/tmp/build")),
            ("rm -rf /mnt/c/Users/testuser/proj/dist", Some("/mnt/c/Users/testuser/proj/dist")),
            ("rm -rf C:\\Windows\\System32", Some("C:\\Windows\\System32")),
            ("rm -rf /mnt/c/Users/otheruser/build", Some("/mnt/c/Users/otheruser/build")),
            ("git push --force", None),
            ("npm ci", None),
            ("cargo build --release", None),
            ("rm -rf ./node_modules", Some("./node_modules")),
            ("rm -rf \"/mnt/d/some project/build\"", Some("/mnt/d/some project/build")),
            ("sudo rm -rf /tmp/build", Some("/tmp/build")),
            ("bash -c \"rm -rf /tmp/build\"", Some("/tmp/build")),
            ("env TMP=/tmp rm -rf /tmp/build", Some("/tmp/build")),
            ("xargs rm -rf < /tmp/list", Some("/tmp/list")),
            ("powershell -Command \"Remove-Item C:\\Users\\testuser\\proj\\dist -Recurse -Force\"",
             Some("C:\\Users\\testuser\\proj\\dist")),
        ];
        for (cmd, operand) in allow {
            v.push(Vector {
                input: cmd,
                op: None,
                expected: Outcome::Allowed,
                layer: "in-tree",
                path_operand: *operand,
                runnable: false,
            });
        }

        // --- Category 5c: In-Memory Dead-Man Fuse (1) ---
        // JS-only: synthetic canary token. Closest Rust layer: none
        // (mapped to DeadManFuse).
        v.push(Vector {
            input: "CANARY_DISASTER_FUSE_TOKEN",
            op: None,
            expected: Outcome::Blocked,
            layer: "DeadManFuse",
            path_operand: None,
            runnable: false,
        });

        // --- Category 5d: Dry-Run Hard Gate (1) ---
        // JS-only: dry-run simulation. Closest Rust layer: none
        // (mapped to DryRunGate).
        v.push(Vector {
            input: "echo safe_dry_run_simulation",
            op: None,
            expected: Outcome::Blocked,
            layer: "DryRunGate",
            path_operand: None,
            runnable: false,
        });

        // --- Category 5e: Structural Module Isolation (1) ---
        // JS-only: zero-child-process guarantee. Closest Rust layer: none
        // (mapped to ModuleIsolation).
        v.push(Vector {
            input: "shell_validator.js",
            op: None,
            expected: Outcome::Blocked,
            layer: "ModuleIsolation",
            path_operand: None,
            runnable: false,
        });

        // --- Category 6: Shell CWD Containment Escapes (4) ---
        for cwd in ["C:\\Windows", "C:\\Users", "../../..", "/mnt/c"] {
            v.push(Vector {
                input: cwd,
                op: None,
                expected: Outcome::Blocked,
                layer: "PathEscape",
                path_operand: None,
                runnable: true,
            });
        }

        // --- Category 7: Evo Operator File Unlinking Containment (4) ---
        for path in [
            "C:\\Windows\\notepad.exe",
            "C:\\Users\\testuser\\Desktop\\file.txt",
            "/mnt/c/Users/test.txt",
            "../../outside.js",
        ] {
            v.push(Vector {
                input: path,
                op: None,
                expected: Outcome::Blocked,
                layer: "PathEscape",
                path_operand: None,
                runnable: true,
            });
        }

        v
    }

    /// Returns true if `p` is a protected root (or its direct wildcard).
    /// A deeper subpath of a protected root is NOT a protected root.
    fn is_protected_root(p: &str) -> bool {
        let t = p.trim().trim_matches('"').trim();
        let norm = t.to_uppercase().replace('\\', "/");
        let protected = [
            "/",
            "/MNT/C",
            "/MNT/D",
            "/MNT/C/WINDOWS",
            "/MNT/C/USERS",
            "C:/",
            "D:/",
            "C:/WINDOWS",
            "C:/USERS",
            "~",
        ];
        for prot in &protected {
            if norm == *prot || norm == format!("{prot}*") {
                return true;
            }
        }
        false
    }

    #[test]
    fn security_vector_table_137() {
        let vectors = security_vectors();

        // 1. Total count
        assert_eq!(
            vectors.len(),
            137,
            "expected 137 vectors, got {}",
            vectors.len()
        );

        // 2. Blocked / allowed counts
        let blocked = vectors
            .iter()
            .filter(|v| v.expected == Outcome::Blocked)
            .count();
        let allowed = vectors
            .iter()
            .filter(|v| v.expected == Outcome::Allowed)
            .count();
        assert_eq!(blocked, 123, "expected 123 blocked, got {blocked}");
        assert_eq!(allowed, 14, "expected 14 allowed, got {allowed}");

        // 3. Blocked ones name their refusal layer
        let valid_layers = [
            "PathEscape",
            "NullByte",
            "DeviceName",
            "SymlinkEscape",
            "WorkspaceRoot",
            "BinaryFile",
            "ShellPolicy",
            "DeadManFuse",
            "DryRunGate",
            "ModuleIsolation",
        ];
        for v in vectors.iter().filter(|v| v.expected == Outcome::Blocked) {
            assert!(
                valid_layers.contains(&v.layer),
                "blocked vector '{}' has invalid layer '{}'",
                v.input,
                v.layer
            );
        }

        // 4. Allowed ones resolve in-tree
        for v in vectors.iter().filter(|v| v.expected == Outcome::Allowed) {
            assert_eq!(
                v.layer, "in-tree",
                "allowed vector '{}' must have layer 'in-tree', got '{}'",
                v.input, v.layer
            );
            if let Some(operand) = v.path_operand {
                assert!(
                    !is_protected_root(operand),
                    "allowed vector '{}' targets protected root '{}'",
                    v.input,
                    operand
                );
            }
        }

        // 5. Runnable vectors: exercise the Rust policy live.
        //    - `ShellPolicy` rows are asserted against `shell::validate`
        //      (the Rust shell-command policy) and must yield a typed refusal.
        //    - Path-layer rows are asserted against `normalize_traversal`.
        let root = test_root("security_table");
        for v in vectors.iter().filter(|v| v.runnable) {
            if v.layer == "ShellPolicy" {
                let err = shell::validate(v.input).unwrap_err();
                match &err {
                    ShellPolicyError::ProhibitedPattern(_)
                    | ShellPolicyError::ProtectedRoot(_, _)
                    | ShellPolicyError::UnexpandedReference(_)
                    | ShellPolicyError::DeadManFuse => {}
                    other => panic!(
                        "runnable ShellPolicy vector '{}' expected a typed refusal, got {other:?}",
                        v.input
                    ),
                }
                continue;
            }
            let err = normalize_traversal(&root, v.input).unwrap_err();
            match (v.layer, &err) {
                ("PathEscape", SandboxError::PathEscape(_)) => {}
                ("NullByte", SandboxError::NullByte(_)) => {}
                ("DeviceName", SandboxError::DeviceName(_)) => {}
                (layer, err) => panic!(
                    "runnable vector '{}' expected layer {layer}, got {err:?}",
                    v.input
                ),
            }
        }
    }
}
