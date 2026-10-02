//! Structural AST search/replace powered by `ast-grep` (tree-sitter).
//!
//! Port of `mcp-castor/src/harness/services/ast_service.js` semantics:
//! - `ast_search` — code-like pattern matching with metavariables (`$VAR`, `$$$BODY`).
//! - `ast_replace` — structural rewrite that preserves formatting, with a
//!   mandatory syntax gate (reparse + ERROR-node check) and per-file rollback.
//!
//! All paths flow through the sandbox layers in [`super::sandbox`].
//!
//! Note on the "parse error" gate: tree-sitter always produces a tree (with
//! error recovery), so a malformed rewrite does not fail to parse — it
//! produces a tree containing `ERROR`/`UNDEFINED` nodes. The syntax gate
//! therefore reparses the rewritten content and treats the presence of any
//! ERROR-kind node as "verified invalid" → rollback.

use std::fs;
use std::path::{Path, PathBuf};

use ast_grep_core::matcher::Pattern;
use ast_grep_core::replacer::Replacer;
use ast_grep_core::tree_sitter::LanguageExt;
use ast_grep_core::Node;
use ast_grep_language::SupportLang;
use thiserror::Error;

use super::sandbox::{self, SandboxError};

/// Directories skipped during recursive walks (mirrors `sandbox_fs.js`).
const IGNORED_DIRS: &[&str] = &[
    ".venv", "venv", "node_modules", ".git", "__pycache__",
    "target", "dist", "build", "vendor", ".idea", ".vscode",
];

/// Files larger than this are skipped (implausible for AST).
const MAX_FILE_BYTES: u64 = 1_000_000;

/// Global cap on matches returned by a search (single file or directory scan).
const MAX_MATCHES: usize = 50;

#[derive(Debug, Error)]
pub enum AstError {
    #[error("{0}")]
    Sandbox(#[from] SandboxError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    InvalidArgs(String),
    #[error("{0}")]
    Pattern(String),
    #[error("{0}")]
    Language(String),
}

/// A single AST match. `line`/`col` are 0-indexed (matching the JS contract).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Match {
    pub file: String,
    pub line: usize,
    pub col: usize,
    pub text: String,
}

/// Summary of a batch replace.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReplaceSummary {
    pub files_scanned: usize,
    pub files_applied: usize,
    pub files_rolled_back: usize,
    pub replacements: usize,
    pub applied: Vec<String>,
    pub rolled_back: Vec<String>,
}

/// Map a file extension to a language alias. Returns `None` when the
/// extension is not in the supported set (file is skipped on directory scans).
fn infer_lang_by_extension(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_lowercase();
    Some(match ext.as_str() {
        "js" | "mjs" | "cjs" | "jsx" => "js",
        "ts" | "mts" | "cts" => "ts",
        "tsx" => "tsx",
        "py" | "pyw" => "python",
        _ => return None,
    })
}

/// Parse a language alias into a `SupportLang`.
fn parse_lang(alias: &str) -> Result<SupportLang, AstError> {
    alias
        .parse::<SupportLang>()
        .map_err(|e| AstError::Language(format!("unsupported language '{alias}': {e}")))
}

/// Recursively collect candidate files under `dir`, skipping ignored
/// directories, over-large files, and files whose language cannot be inferred.
fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if IGNORED_DIRS.contains(&name.as_str()) {
            continue;
        }
        let full = entry.path();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            collect_files(&full, out);
        } else if ft.is_file() {
            let size = match entry.metadata() {
                Ok(m) => m.len(),
                Err(_) => continue,
            };
            if size > MAX_FILE_BYTES {
                continue;
            }
            if infer_lang_by_extension(&full).is_none() {
                continue;
            }
            out.push(full);
        }
    }
}

/// Resolve a search/replace target to a list of files to process.
/// A file target yields a single-element list; a directory target is walked.
fn resolve_files(target: &Path) -> Result<Vec<PathBuf>, AstError> {
    if !target.exists() {
        return Err(AstError::InvalidArgs(format!(
            "Path does not exist: {}",
            target.display()
        )));
    }
    if target.is_file() {
        return Ok(vec![target.to_path_buf()]);
    }
    let mut files = Vec::new();
    collect_files(target, &mut files);
    files.sort();
    Ok(files)
}

/// Run the sandbox containment layers for a raw target path string, returning
/// the resolved in-tree path.
fn resolve_target(root: &Path, raw: &str) -> Result<PathBuf, AstError> {
    let resolved_root = sandbox::resolve_workspace_root(root)?;
    let normalized = sandbox::normalize_traversal(&resolved_root, raw)?;
    sandbox::refuse_out_of_tree(&resolved_root, &normalized)?;
    sandbox::verify_symlink_containment(&normalized, &resolved_root)?;
    Ok(normalized)
}

/// Search for a syntactic pattern under `root`.
///
/// `lang` is a language alias (e.g. `"ts"`, `"js"`, `"python"`). When the
/// target is a directory, the language is inferred per-file by extension and
/// `lang` is used only as a fallback.
pub fn ast_search(root: &Path, pattern: &str, lang: &str) -> Result<Vec<Match>, AstError> {
    if pattern.trim().is_empty() {
        return Err(AstError::InvalidArgs("AST search requires a non-empty pattern".into()));
    }
    let target = resolve_target(root, &root.to_string_lossy())?;
    let files = resolve_files(&target)?;

    let mut matches = Vec::new();
    for file in &files {
        if matches.len() >= MAX_MATCHES {
            break;
        }
        let file_lang = infer_lang_by_extension(file).unwrap_or(lang);
        let lang = match parse_lang(file_lang) {
            Ok(l) => l,
            Err(_) => continue, // language unavailable -> skip this file
        };
        let content = match fs::read_to_string(file) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let doc = lang.ast_grep(&content);
        let pat = match Pattern::try_new(pattern, lang) {
            Ok(p) => p,
            Err(e) => return Err(AstError::Pattern(e.to_string())),
        };
        for m in doc.root().find_all(pat) {
            if matches.len() >= MAX_MATCHES {
                break;
            }
            let pos = m.start_pos();
            matches.push(Match {
                file: file.to_string_lossy().to_string(),
                line: pos.line(),
                col: pos.column(m.get_node()),
                text: m.text().to_string(),
            });
        }
    }
    Ok(matches)
}

/// Replace a syntactic pattern under `root`, applying the rewrite per file
/// with a syntax gate (reparse + ERROR-node check) and per-file rollback.
///
/// `lang` is a language alias; when the target is a directory the language is
/// inferred per-file by extension (falling back to `lang`).
pub fn ast_replace(
    root: &Path,
    pattern: &str,
    replacement: &str,
    lang: &str,
) -> Result<ReplaceSummary, AstError> {
    if pattern.trim().is_empty() {
        return Err(AstError::InvalidArgs("AST replace requires a non-empty pattern".into()));
    }
    let target = resolve_target(root, &root.to_string_lossy())?;
    let files = resolve_files(&target)?;

    let mut summary = ReplaceSummary::default();
    summary.files_scanned = files.len();

    for file in &files {
        let file_lang = infer_lang_by_extension(file).unwrap_or(lang);
        let lang = match parse_lang(file_lang) {
            Ok(l) => l,
            Err(e) => {
                summary.files_rolled_back += 1;
                summary.rolled_back.push(file.to_string_lossy().to_string());
                let _ = e;
                continue;
            }
        };

        let original = match fs::read_to_string(file) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let result = replace_in_memory(&original, pattern, replacement, lang);
        match result {
            Ok((new_content, replacements)) => {
                if new_content == original {
                    continue; // no match -> not counted
                }
                // Syntax gate: reparse the new content; any ERROR node -> rollback.
                if syntax_gate(&new_content, lang) {
                    // Verified invalid: leave the file unchanged (never written).
                    summary.files_rolled_back += 1;
                    summary.rolled_back.push(file.to_string_lossy().to_string());
                    continue;
                }
                if let Err(e) = fs::write(file, &new_content) {
                    summary.files_rolled_back += 1;
                    summary.rolled_back.push(file.to_string_lossy().to_string());
                    let _ = e;
                    continue;
                }
                summary.files_applied += 1;
                summary.replacements += replacements;
                summary.applied.push(file.to_string_lossy().to_string());
            }
            Err(e) => {
                // Parse/pattern failure on this file -> skip, continue the batch.
                let _ = e;
                continue;
            }
        }
    }

    Ok(summary)
}

/// Compute the rewrite fully in memory. Returns `(new_content, replacements)`.
fn replace_in_memory(
    original: &str,
    pattern: &str,
    replacement: &str,
    lang: SupportLang,
) -> Result<(String, usize), AstError> {
    let doc = lang.ast_grep(original);
    let pat = Pattern::try_new(pattern, lang)
        .map_err(|e| AstError::Pattern(e.to_string()))?;

    // Collect the edits as owned values (they do not borrow the doc), so the
    // matches can be dropped before we mutate the source.
    let edits: Vec<ast_grep_core::source::Edit<String>> =
        doc.root().find_all(pat).map(|m| m.replace_by(replacement)).collect();
    if edits.is_empty() {
        return Ok((original.to_string(), 0));
    }

    // Splice the edits in reverse source order so earlier offsets stay valid.
    let mut src = original.to_string();
    for edit in edits.iter().rev() {
        let end = edit.position + edit.deleted_length;
        src.replace_range(edit.position..end, &String::from_utf8_lossy(&edit.inserted_text));
    }

    Ok((src, edits.len()))
}

/// Syntax gate: reparse `content` and report whether any ERROR-kind node is
/// present (tree-sitter error recovery). Presence means the rewrite is
/// malformed and the file must be rolled back.
fn syntax_gate(content: &str, lang: SupportLang) -> bool {
    let doc = lang.ast_grep(content);
    let mut has_error = false;
    walk_for_errors(doc.root(), &mut has_error);
    has_error
}

fn walk_for_errors(
    node: Node<ast_grep_core::tree_sitter::StrDoc<SupportLang>>,
    out: &mut bool,
) {
    if *out {
        return;
    }
    let kind = node.kind();
    if kind == "ERROR" || kind == "UNDEFINED" {
        *out = true;
        return;
    }
    for child in node.children() {
        walk_for_errors(child, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "castor_ast_{}_{}",
            std::process::id(),
            name
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        root
    }

    #[test]
    fn search_finds_pattern_in_fixture() {
        let root = test_root("search");
        let file = root.join("src").join("app.ts");
        fs::write(
            &file,
            "function greet(name) {\n  return `hi ${name}`;\n}\n",
        )
        .unwrap();

        let matches = ast_search(&root, "function $NAME($$$ARGS) { $$$BODY }", "ts").unwrap();
        assert!(!matches.is_empty(), "expected at least one match");
        let m = &matches[0];
        assert_eq!(m.file, file.to_string_lossy());
        assert_eq!(m.line, 0);
        assert_eq!(m.col, 0);
        assert!(m.text.contains("greet"), "match text: {}", m.text);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn replace_applies_and_reparses_clean() {
        let root = test_root("replace_ok");
        let file = root.join("src").join("app.ts");
        let original = "function greet(name) {\n  return `hi ${name}`;\n}\n";
        fs::write(&file, original).unwrap();

        let summary = ast_replace(
            &root,
            "function $NAME($$$ARGS) { $$$BODY }",
            "function renamed($$$ARGS) { $$$BODY }",
            "ts",
        )
        .unwrap();

        assert_eq!(summary.files_applied, 1, "expected one applied file");
        assert_eq!(summary.files_rolled_back, 0, "expected no rollbacks");
        assert_eq!(summary.replacements, 1);
        assert_eq!(summary.applied, vec![file.to_string_lossy().to_string()]);

        let new_content = fs::read_to_string(&file).unwrap();
        assert!(new_content.contains("renamed"), "content: {new_content}");
        assert!(!new_content.contains("greet"), "content: {new_content}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn invalid_replacement_rolls_back() {
        let root = test_root("replace_bad");
        let file = root.join("src").join("app.ts");
        let original = "function greet(name) {\n  return `hi ${name}`;\n}\n";
        fs::write(&file, original).unwrap();

        // A replacement that produces malformed syntax (a dangling `function`
        // with no body) must be rolled back: the file stays unchanged and the
        // file is named in the rolled-back list.
        let summary = ast_replace(
            &root,
            "function $NAME($$$ARGS) { $$$BODY }",
            "function broken(",
            "ts",
        )
        .unwrap();

        assert_eq!(summary.files_rolled_back, 1, "expected one rolled-back file");
        assert_eq!(summary.files_applied, 0);
        assert_eq!(
            summary.rolled_back,
            vec![file.to_string_lossy().to_string()],
            "rolled-back list must name the file"
        );

        let after = fs::read_to_string(&file).unwrap();
        assert_eq!(after, original, "file must be unchanged after rollback");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn out_of_tree_root_refused() {
        // A non-existent absolute root is refused by the sandbox before any
        // AST work happens.
        let missing = std::env::temp_dir().join("castor_ast_missing_never");
        let err = ast_search(&missing, "function $N() {}", "ts").unwrap_err();
        assert!(
            matches!(err, AstError::Sandbox(SandboxError::WorkspaceRoot(_))),
            "expected a sandbox refusal, got {err:?}"
        );
    }
}
