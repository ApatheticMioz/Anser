//! Pure in-memory shell command policy validator, ported from
//! `mcp-castor/src/harness/services/shell_validator.js`.
//!
//! No execution, no config, no env, no globals. `validate` classifies a
//! command string and returns a typed refusal error for dangerous classes
//! (fork bombs, disk wipes, `rm`/`del` on protected roots, `dd` to devices,
//! `sudo`/wrapper unwrapping, unexpanded shell references, dead-man fuse).
//! Benign commands pass.

use std::sync::OnceLock;

use regex::Regex;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ShellPolicyError {
    #[error("InvalidCommandError: Shell command must be a non-empty string")]
    InvalidCommand,
    #[error("CommandSecurityError: Execution blocked. Command matches prohibited destructive pattern: {0}")]
    ProhibitedPattern(String),
    #[error("CommandSecurityError: Execution blocked. Unexpanded shell reference in target '{0}'")]
    UnexpandedReference(String),
    #[error("CommandSecurityError: Execution blocked. Target '{0}' resolves to protected root: {1}")]
    ProtectedRoot(String, String),
    #[error("FatalDeadManFuseError: Execution halted by dead-man fuse (synthetic canary tripped)")]
    DeadManFuse,
}

pub const CANARY_DISASTER_FUSE_TOKEN: &str = "__CANARY_TRIGGER_DISASTER_FUSE__";

const DEFAULT_CWD: &str = "/workspace";
const HOME: &str = "/home/user";
const MAX_UNWRAP_DEPTH: usize = 4;

const DESTRUCTIVE: &[&str] = &["rm", "del", "rmdir", "rd", "remove-item", "ri", "erase"];
const TRANSPARENT: &[&str] = &["sudo", "doas", "env", "nice", "nohup", "xargs"];
const WIN_FLAGS: &[&str] = &["/f", "/s", "/q", "/p", "/a", "/c", "/e", "/t", "/y", "/i"];

// ---------------------------------------------------------------------------
// Pattern-level blocks (verbatim, not path-aware).
// ---------------------------------------------------------------------------

/// Precompiled pattern-level block signatures, modeled on
/// `mcp-castor/src/harness/services/shell_validator.js` `PATTERN_LEVEL_BLOCKS`.
/// Whitespace between tokens is tolerated (`\s*` / `\s+`) so spacing variants
/// (e.g. `:() { :|:& };`) cannot bypass the matcher.
fn pattern_blocks() -> &'static [(&'static str, Regex)] {
    static BLOCKS: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    BLOCKS.get_or_init(|| {
        vec![
            (
                "fork bomb",
                Regex::new(r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;").unwrap(),
            ),
            (
                "disk partitioning",
                Regex::new(r"\b(mkfs(\.[a-z0-9]+)?|fdisk|parted)\b").unwrap(),
            ),
            (
                "drive format",
                Regex::new(r"\bformat\s+[A-Za-z]:").unwrap(),
            ),
            (
                "dd to raw device",
                Regex::new(r"\bdd\s+.*of=/dev/(sd[a-z]|nvme|hd[a-z]|vd[a-z])").unwrap(),
            ),
        ]
    })
}

fn pattern_level_block(cmd: &str) -> Option<&'static str> {
    let lower = cmd.to_ascii_lowercase();
    for (sig, re) in pattern_blocks() {
        if re.is_match(&lower) {
            return Some(sig);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Tokenizer and segment splitter
// ---------------------------------------------------------------------------

fn tokenize(cmd: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for ch in cmd.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => cur.push(ch),
            None if ch == '"' || ch == '\'' => quote = Some(ch),
            None if ch == ' ' || ch == '\t' => {
                if !cur.is_empty() {
                    tokens.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(ch),
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    tokens
}

fn flush_seg(segments: &mut Vec<String>, cur: &mut String) {
    let t = cur.trim().to_string();
    if !t.is_empty() {
        segments.push(t);
    }
    cur.clear();
}

fn split_segments(cmd: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let chars: Vec<char> = cmd.chars().collect();
    let n = chars.len();
    let mut i = 0;
    while i < n {
        let ch = chars[i];
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            }
            cur.push(ch);
            i += 1;
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            cur.push(ch);
            i += 1;
            continue;
        }
        if ch == '&' && i + 1 < n && chars[i + 1] == '&' {
            flush_seg(&mut segments, &mut cur);
            i += 2;
            continue;
        }
        if ch == '|' && i + 1 < n && chars[i + 1] == '|' {
            flush_seg(&mut segments, &mut cur);
            i += 2;
            continue;
        }
        if ch == ';' || ch == '|' || ch == '\n' || ch == '\r' {
            flush_seg(&mut segments, &mut cur);
            i += 1;
            continue;
        }
        cur.push(ch);
        i += 1;
    }
    flush_seg(&mut segments, &mut cur);
    segments
}

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

fn command_name(token: &str) -> String {
    let parts: Vec<&str> = token.split(|c| c == '/' || c == '\\').collect();
    parts.last().unwrap_or(&"").to_ascii_lowercase()
}

fn is_flag(token: &str) -> bool {
    if token.starts_with('-') {
        return true;
    }
    WIN_FLAGS.contains(&token.to_ascii_lowercase().as_str())
}

fn has_unexpanded_ref(operand: &str) -> bool {
    operand.contains('$') || operand.contains('`')
}

fn is_env_assignment(token: &str) -> bool {
    let bytes = token.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    if !bytes[0].is_ascii_alphabetic() && bytes[0] != b'_' {
        return false;
    }
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'=' {
            return i > 0;
        }
        if !b.is_ascii_alphanumeric() && b != b'_' {
            return false;
        }
    }
    false
}

fn expand_tilde(operand: &str, is_win: bool) -> String {
    if operand == "~" {
        return HOME.to_string();
    }
    if operand.starts_with("~/") || operand.starts_with("~\\") {
        return format!("{HOME}{}", &operand[1..].replace('\\', "/"));
    }
    if let Some(rest) = operand.strip_prefix('~') {
        if !rest.is_empty() && rest.as_bytes()[0] != b'/' && rest.as_bytes()[0] != b'\\' {
            if is_win {
                return format!("C:\\Users\\{rest}");
            }
            if rest == "root" {
                return "/root".to_string();
            }
            return format!("/home/{rest}");
        }
    }
    operand.to_string()
}

fn to_posix(p: &str) -> String {
    let t = p.trim();
    if t.is_empty() {
        return HOME.to_string();
    }
    if let Some(rest) = t
        .strip_prefix(r"\\wsl.localhost\")
        .or_else(|| t.strip_prefix(r"\\wsl$\\"))
    {
        let parts: Vec<&str> = rest.split('\\').collect();
        if parts.len() >= 2 {
            let sub = parts[1..].join("/");
            return format!("/{sub}");
        }
    }
    if t.len() >= 3 {
        let b0 = t.as_bytes()[0];
        let b1 = t.as_bytes()[1];
        if b0.is_ascii_alphabetic()
            && b1 == b':'
            && (t.as_bytes()[2] == b'\\' || t.as_bytes()[2] == b'/')
        {
            let drive = b0 as char;
            let sub = t[3..].replace('\\', "/");
            return format!("/mnt/{}/{}", drive.to_ascii_lowercase(), sub);
        }
    }
    if t.len() >= 3 && t.starts_with('/') {
        let b1 = t.as_bytes()[1];
        if b1.is_ascii_alphabetic() && t.as_bytes()[2] == b'/' {
            let drive = b1 as char;
            let sub = t[3..].to_string();
            return format!("/mnt/{}/{}", drive.to_ascii_lowercase(), sub);
        }
    }
    t.replace('\\', "/")
}

fn posix_normalize(p: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for comp in p.split('/') {
        if comp.is_empty() || comp == "." {
            continue;
        }
        if comp == ".." {
            parts.pop();
        } else {
            parts.push(comp);
        }
    }
    if parts.is_empty() {
        return "/".to_string();
    }
    format!("/{}", parts.join("/"))
}

fn normalize_operand(operand: &str, cwd: &str, is_win: bool) -> String {
    let p = expand_tilde(operand, is_win);
    let mut posix = to_posix(&p);
    let mut wildcard = "";
    if posix.ends_with("/*") {
        wildcard = "/*";
        posix = posix[..posix.len() - 2].to_string();
    } else if posix.ends_with('*') {
        wildcard = "*";
        posix = posix[..posix.len() - 1].to_string();
    }
    if posix.is_empty() {
        posix = "/".to_string();
    }
    if !posix.starts_with('/') {
        let cwd_posix = to_posix(cwd);
        posix = posix_normalize(&format!("{cwd_posix}/{posix}"));
    } else {
        posix = posix_normalize(&posix);
    }
    if posix != "/" && posix.ends_with('/') {
        while posix.ends_with('/') {
            posix.pop();
        }
    }
    if !wildcard.is_empty() {
        posix = if posix == "/" {
            wildcard.to_string()
        } else {
            format!("{posix}{wildcard}")
        };
    }
    posix.to_ascii_lowercase()
}

// ---------------------------------------------------------------------------
// Protected roots
// ---------------------------------------------------------------------------

fn protected_roots() -> Vec<String> {
    let mut v = vec!["/".to_string(), "/root".to_string(), "/home".to_string()];
    for c in b'a'..=b'z' {
        v.push(format!("/mnt/{}", c as char));
    }
    v.push("/mnt/c/windows".to_string());
    v.push("/mnt/c/users".to_string());
    v.push("/mnt/c/program files".to_string());
    v
}

fn is_home_user(p: &str) -> bool {
    let rest = p.strip_prefix("/home/").unwrap_or("");
    !rest.is_empty() && !rest.contains('/')
}

fn is_dev_target(p: &str) -> bool {
    let rest = match p.strip_prefix("/dev/") {
        Some(r) => r,
        None => return false,
    };
    let name = match rest.strip_suffix("/*") {
        Some(n) => n,
        None => rest,
    };
    let (kind, tail) = match name {
        n if n.len() >= 3 && &n[..2] == "sd" => ("sd", &n[2..]),
        n if n.len() >= 3 && &n[..2] == "hd" => ("hd", &n[2..]),
        n if n.len() >= 3 && &n[..2] == "vd" => ("vd", &n[2..]),
        n if n.len() >= 5 && &n[..4] == "nvme" => ("nvme", &n[4..]),
        _ => return false,
    };
    match kind {
        "sd" | "hd" | "vd" => !tail.is_empty() && tail.chars().all(|c| c.is_ascii_lowercase()),
        "nvme" => {
            let d1: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
            let rem = &tail[d1.len()..];
            let rem = match rem.strip_prefix('n') {
                Some(r) => r,
                None => return false,
            };
            let d2: String = rem.chars().take_while(|c| c.is_ascii_digit()).collect();
            !d1.is_empty() && !d2.is_empty() && rem.len() == d2.len()
        }
        _ => false,
    }
}

fn is_protected_root(p: &str) -> bool {
    let p = p.to_ascii_lowercase();
    if is_dev_target(&p) {
        return true;
    }
    for root in protected_roots() {
        if p == root {
            return true;
        }
        let w = if root == "/" { "/*" } else { &format!("{root}/*") };
        if p == w {
            return true;
        }
    }
    if p == "/root" || is_home_user(&p) {
        return true;
    }
    false
}

// ---------------------------------------------------------------------------
// Shell wrapper recursion
// ---------------------------------------------------------------------------

fn shell_wrapper(name: &str) -> Option<(&'static [&'static str], &'static str)> {
    match name {
        "bash" | "sh" | "dash" | "zsh" => Some((&["-c"], "single")),
        "cmd" | "cmd.exe" => Some((&["/c"], "rest")),
        "powershell" | "pwsh" => Some((&["-command"], "single")),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

fn analyze_segment(cmd: &str, cwd: &str, depth: usize) -> Result<(), ShellPolicyError> {
    let tokens = tokenize(cmd);
    if tokens.is_empty() {
        return Ok(());
    }

    let mut i = 0;
    while i < tokens.len() {
        let name = command_name(&tokens[i]);
        if name == "env" {
            i += 1;
            while i < tokens.len() && is_env_assignment(&tokens[i]) {
                i += 1;
            }
            continue;
        }
        if TRANSPARENT.contains(&name.as_str()) {
            i += 1;
            continue;
        }
        break;
    }
    if i >= tokens.len() {
        return Ok(());
    }

    let name = command_name(&tokens[i]);

    if let Some((flags, inner)) = shell_wrapper(&name) {
        if depth < MAX_UNWRAP_DEPTH
            && i + 1 < tokens.len()
            && flags.contains(&tokens[i + 1].to_ascii_lowercase().as_str())
        {
            let inner_cmd = if inner == "single" {
                tokens.get(i + 2).cloned()
            } else {
                (i + 2 < tokens.len()).then(|| tokens[i + 2..].join(" "))
            };
            if let Some(inner_cmd) = inner_cmd {
                analyze_command(&inner_cmd, cwd, depth + 1)?;
            }
        }
        return Ok(());
    }

    if DESTRUCTIVE.contains(&name.as_str()) {
        let is_win = name != "rm";
        let mut operands = Vec::new();
        for j in (i + 1)..tokens.len() {
            let tok = &tokens[j];
            if let Some(eq) = tok.find('=') {
                if eq > 0 && (tok.starts_with('-') || tok.starts_with('/')) {
                    let value = &tok[eq + 1..];
                    if !value.is_empty() {
                        operands.push(value.to_string());
                    }
                    continue;
                }
            }
            if !is_flag(tok) {
                operands.push(tok.clone());
            }
        }
        for operand in &operands {
            if has_unexpanded_ref(operand) {
                return Err(ShellPolicyError::UnexpandedReference(operand.clone()));
            }
            let normalized = normalize_operand(operand, cwd, is_win);
            if is_protected_root(&normalized) {
                return Err(ShellPolicyError::ProtectedRoot(
                    operand.clone(),
                    normalized,
                ));
            }
        }
    }

    Ok(())
}

fn analyze_command(cmd: &str, cwd: &str, depth: usize) -> Result<(), ShellPolicyError> {
    if let Some(sig) = pattern_level_block(cmd) {
        return Err(ShellPolicyError::ProhibitedPattern(sig.to_string()));
    }
    for seg in split_segments(cmd) {
        analyze_segment(&seg, cwd, depth)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

pub fn validate(cmd: &str) -> Result<(), ShellPolicyError> {
    if cmd.trim().is_empty() {
        return Err(ShellPolicyError::InvalidCommand);
    }
    if cmd.contains(CANARY_DISASTER_FUSE_TOKEN) {
        return Err(ShellPolicyError::DeadManFuse);
    }
    analyze_command(cmd, DEFAULT_CWD, 0)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fork_bomb_blocked() {
        assert!(matches!(
            validate(":(){ :|:& };:"),
            Err(ShellPolicyError::ProhibitedPattern(_))
        ));
    }

    #[test]
    fn fork_bomb_no_space_blocked() {
        assert!(matches!(
            validate(":(){ :|:& };"),
            Err(ShellPolicyError::ProhibitedPattern(_))
        ));
    }

    #[test]
    fn fork_bomb_space_before_brace_blocked() {
        assert!(matches!(
            validate(":() { :|:& };"),
            Err(ShellPolicyError::ProhibitedPattern(_))
        ));
    }

    #[test]
    fn mkfs_blocked() {
        assert!(matches!(
            validate("mkfs.ext4 /dev/sda1"),
            Err(ShellPolicyError::ProhibitedPattern(_))
        ));
    }

    #[test]
    fn fdisk_blocked() {
        assert!(matches!(
            validate("fdisk /dev/sda"),
            Err(ShellPolicyError::ProhibitedPattern(_))
        ));
    }

    #[test]
    fn format_drive_blocked() {
        assert!(matches!(
            validate("format C:"),
            Err(ShellPolicyError::ProhibitedPattern(_))
        ));
    }

    #[test]
    fn dd_to_device_blocked() {
        assert!(matches!(
            validate("dd if=/dev/zero of=/dev/sda"),
            Err(ShellPolicyError::ProhibitedPattern(_))
        ));
    }

    #[test]
    fn rm_rf_root_blocked() {
        assert!(matches!(
            validate("rm -rf /"),
            Err(ShellPolicyError::ProtectedRoot(_, _))
        ));
    }

    #[test]
    fn rm_rf_home_blocked() {
        assert!(matches!(
            validate("rm -rf /home/user"),
            Err(ShellPolicyError::ProtectedRoot(_, _))
        ));
    }

    #[test]
    fn sudo_rm_blocked() {
        assert!(matches!(
            validate("sudo rm -rf /"),
            Err(ShellPolicyError::ProtectedRoot(_, _))
        ));
    }

    #[test]
    fn bash_c_rm_blocked() {
        assert!(matches!(
            validate("bash -c \"rm -rf /\""),
            Err(ShellPolicyError::ProtectedRoot(_, _))
        ));
    }

    #[test]
    fn unexpanded_ref_blocked() {
        assert!(matches!(
            validate("rm -rf $HOME"),
            Err(ShellPolicyError::UnexpandedReference(_))
        ));
    }

    #[test]
    fn deadman_fuse_canary() {
        assert!(matches!(
            validate(CANARY_DISASTER_FUSE_TOKEN),
            Err(ShellPolicyError::DeadManFuse)
        ));
    }

    #[test]
    fn empty_command_rejected() {
        assert!(matches!(
            validate("   "),
            Err(ShellPolicyError::InvalidCommand)
        ));
    }

    #[test]
    fn benign_commands_pass() {
        assert!(validate("ls -la").is_ok());
        assert!(validate("cargo build").is_ok());
        assert!(validate("rm -rf ./build").is_ok());
        assert!(validate("echo hello").is_ok());
        assert!(validate("cat file.txt").is_ok());
        assert!(validate("git status").is_ok());
    }
}
