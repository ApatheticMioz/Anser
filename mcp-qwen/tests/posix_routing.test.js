/**
 * P4g - POSIX shell routing for the bash tool.
 *
 * Verifies:
 *   (a) posixShell() resolution: returns a path on this machine; result is
 *       cached; QWEN_POSIX_SHELL override honored; bogus path -> null (probe
 *       guards).
 *   (b) Routing decision (LIVE, Windows-only): with a POSIX shell available,
 *       `echo hello | tr a-z A-Z` -> stdout `HELLO`, exit 0 (Bug 1.1 repro
 *       class); `node -e "console.log('quotes-survive')"` -> exact stdout, no
 *       mangling (Bug 1.2 repro class); a multi-line quoted node -e script
 *       works; a color-forcing parent env (FORCE_COLOR) cannot leak ANSI
 *       escapes into tool output (P14, b4).
 *   (c) Fallback: QWEN_SHELL_MODE=cmd still executes a simple command
 *       (regression lock); with mode=cmd the POSIX shell is never spawned.
 *   (d) Security ordering: a dry-run request returns the simulated result
 *       even for a command that would route through bash; validator still
 *       rejects a destructive command before any routing (must throw, never
 *       spawn).
 *   (e) CWD fidelity: a POSIX-style cwd (/mnt/d/x) is translated with
 *       toWindowsPath() before use (never by naive string concat).
 *
 * Live vectors are skip-guarded where a live shell is genuinely absent.
 * This machine HAS Git Bash, so live vectors should run.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const {
  posixShell,
  _resetPosixShellCache,
  setPosixShellProbeCandidate,
  toWindowsPath,
} = await import("../src/platform.js");

const { ShellExecutorService } = await import(
  "../src/harness/services/shell_executor.js"
);

const IS_WINDOWS = process.platform === "win32";

let passed = 0;
let failed = 0;
function assertOk(cond, name) {
  if (cond) {
    console.log(`[PASS] ${name}`);
    passed++;
  } else {
    console.error(`[FAIL] ${name}`);
    failed++;
  }
}

/** Save/restore process.env around a (possibly async) test block. */
async function withEnv(vars, fn) {
  const saved = { ...process.env };
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === null) delete process.env[k];
      else process.env[k] = v;
    }
    await fn();
  } finally {
    process.env = saved;
  }
}

async function main() {
  // -------------------------------------------------------------------------
  // (a) posixShell() resolution
  // -------------------------------------------------------------------------
  {
    // (a1) Returns a path on this machine (Git Bash is present).
    _resetPosixShellCache();
    setPosixShellProbeCandidate(null); // real probe
    await withEnv({ QWEN_POSIX_SHELL: null }, () => {
      const p = posixShell();
      assertOk(
        typeof p === "string" && p.length > 0,
        `posixShell() returns a path on this machine (got: ${p})`
      );
    });

    // (a2) Result is cached (same value on second call).
    _resetPosixShellCache();
    setPosixShellProbeCandidate(null);
    await withEnv({ QWEN_POSIX_SHELL: null }, () => {
      const p1 = posixShell();
      const p2 = posixShell();
      assertOk(
        p1 === p2,
        `posixShell() result is cached (p1 === p2: ${p1 === p2})`
      );
    });

    // (a3) QWEN_POSIX_SHELL override honored.
    // The override path must be a REAL, probe-passing shell on the current
    // platform: a Windows Git-Bash path on win32, a POSIX path elsewhere.
    // (The original hardcoded a Windows path, which does not exist on Linux
    // and so failed the probe, falling through to the PATH bash.)
    _resetPosixShellCache();
    setPosixShellProbeCandidate(null);
    const overridePath = IS_WINDOWS
      ? "C:\\Program Files\\Git\\bin\\bash.exe"
      : "/usr/bin/bash";
    await withEnv({ QWEN_POSIX_SHELL: overridePath }, () => {
      const p = posixShell();
      assertOk(
        p === overridePath,
        `QWEN_POSIX_SHELL override honored (got: ${p})`
      );
    });

    // (a4) Bogus QWEN_POSIX_SHELL path -> null (probe guards).
    // Inject a failing probe so NO candidate (env, Git Bash, PATH) can pass.
    // The bogus path is platform-shaped (Windows path on win32, POSIX path
    // elsewhere) but is guaranteed non-existent on either.
    _resetPosixShellCache();
    setPosixShellProbeCandidate(() => false);
    const bogusPath = IS_WINDOWS
      ? "C:\\bogus\\nonexistent\\bash.exe"
      : "/bogus/nonexistent/bash";
    await withEnv({ QWEN_POSIX_SHELL: bogusPath }, () => {
      const p = posixShell();
      assertOk(p === null, `bogus QWEN_POSIX_SHELL path -> null (got: ${p})`);
    });
    setPosixShellProbeCandidate(null); // restore real probe
    _resetPosixShellCache();
  }

  // -------------------------------------------------------------------------
  // (b) Routing decision (LIVE, Windows-only)
  // -------------------------------------------------------------------------
  {
    const shell = posixShell();
    if (!IS_WINDOWS || !shell) {
      console.log(
        `[SKIP] Live routing tests (not Windows or no POSIX shell: ${shell})`
      );
    } else {
      const executor = new ShellExecutorService({ cwd: REPO_ROOT });

      // (b1) Bug 1.1 repro class: POSIX pipe works.
      await withEnv(
        { QWEN_SHELL_MODE: null, QWEN_POSIX_SHELL: null },
        async () => {
          const res = await executor.execute({
            command: "echo hello | tr a-z A-Z",
          });
          assertOk(
            res.exitCode === 0 && res.stdout.trim() === "HELLO",
            `Bug 1.1: echo hello | tr a-z A-Z -> ${JSON.stringify(
              res.stdout.trim()
            )} (exit ${res.exitCode})`
          );
        }
      );

      // (b2) Bug 1.2 repro class: quotes survive intact.
      await withEnv(
        { QWEN_SHELL_MODE: null, QWEN_POSIX_SHELL: null },
        async () => {
          const res = await executor.execute({
            command: 'node -e "console.log(\'quotes-survive\')"',
          });
          assertOk(
            res.exitCode === 0 && res.stdout.trim() === "quotes-survive",
            `Bug 1.2: node -e quotes survive -> ${JSON.stringify(
              res.stdout.trim()
            )} (exit ${res.exitCode})`
          );
        }
      );

      // (b3) Multi-line quoted node -e script works.
      await withEnv(
        { QWEN_SHELL_MODE: null, QWEN_POSIX_SHELL: null },
        async () => {
          const script = "const a = 1;\nconst b = 2;\nconsole.log(a + b);";
          const res = await executor.execute({
            command: `node -e "${script}"`,
          });
          assertOk(
            res.exitCode === 0 && res.stdout.trim() === "3",
            `Multi-line node -e -> ${JSON.stringify(res.stdout.trim())} (exit ${res.exitCode})`
          );
        }
      );

      // (b4) P14: a color-forcing parent env must not leak ANSI escapes
      // into tool output (Node >= 24 honors FORCE_COLOR even on piped
      // stdout; the executor strips it before spawning).
      await withEnv(
        {
          QWEN_SHELL_MODE: null,
          QWEN_POSIX_SHELL: null,
          FORCE_COLOR: "3",
          NO_COLOR: null,
        },
        async () => {
          const res = await executor.execute({
            command: 'node -e "console.log(\'plain-text\')"',
          });
          assertOk(
            res.exitCode === 0 &&
              res.stdout.trim() === "plain-text" &&
              !res.stdout.includes("\u001b"),
            `P14: FORCE_COLOR=3 parent env -> ANSI-free output (got ${JSON.stringify(
              res.stdout.trim()
            )}, exit ${res.exitCode})`
          );
        }
      );
    }
  }

  // -------------------------------------------------------------------------
  // (c) Fallback: QWEN_SHELL_MODE=cmd
  // -------------------------------------------------------------------------
  {
    if (!IS_WINDOWS) {
      console.log("[SKIP] QWEN_SHELL_MODE=cmd fallback (not Windows)");
    } else {
      const executor = new ShellExecutorService({ cwd: REPO_ROOT });

      // (c1) QWEN_SHELL_MODE=cmd still executes a simple command.
      await withEnv(
        { QWEN_SHELL_MODE: "cmd", QWEN_POSIX_SHELL: null },
        async () => {
          const res = await executor.execute({ command: "echo cmd-mode-ok" });
          assertOk(
            res.exitCode === 0 && res.stdout.trim() === "cmd-mode-ok",
            `QWEN_SHELL_MODE=cmd: echo cmd-mode-ok -> ${JSON.stringify(
              res.stdout.trim()
            )} (exit ${res.exitCode})`
          );
        }
      );

      // (c2) With mode=cmd the POSIX shell is never spawned.
      // Prove by setting QWEN_POSIX_SHELL to a bogus path: if the POSIX shell
      // were used, the command would fail. It succeeds -> cmd.exe was used.
      await withEnv(
        {
          QWEN_SHELL_MODE: "cmd",
          QWEN_POSIX_SHELL: "C:\\bogus\\nonexistent\\bash.exe",
        },
        async () => {
          const res = await executor.execute({
            command: "echo posix-never-spawned",
          });
          assertOk(
            res.exitCode === 0 && res.stdout.trim() === "posix-never-spawned",
            `QWEN_SHELL_MODE=cmd: POSIX shell never spawned (bogus path ignored) -> ${JSON.stringify(
              res.stdout.trim()
            )} (exit ${res.exitCode})`
          );
        }
      );
    }
  }

  // -------------------------------------------------------------------------
  // (d) Security ordering
  // -------------------------------------------------------------------------
  {
    // (d1) Dry-run request returns the simulated result even for a command
    // that would route through bash.
    const dryRunExecutor = new ShellExecutorService({
      cwd: REPO_ROOT,
      dryRun: true,
    });
    await withEnv(
      { QWEN_SHELL_MODE: null, QWEN_POSIX_SHELL: null },
      async () => {
        const res = await dryRunExecutor.execute({
          command: "echo hello | tr a-z A-Z",
        });
        assertOk(
          res.stdout === "[DRY-RUN SIMULATED]" && res.exitCode === 0,
          `Dry-run gate returns simulated result for bash-routed command -> ${JSON.stringify(
            res.stdout
          )}`
        );
      }
    );

    // (d2) Validator rejects a destructive command before any routing
    // (must throw, never spawn).
    const liveExecutor = new ShellExecutorService({ cwd: REPO_ROOT });
    await withEnv(
      { QWEN_SHELL_MODE: null, QWEN_POSIX_SHELL: null },
      async () => {
        let threw = false;
        let errMsg = "";
        try {
          await liveExecutor.execute({ command: "rm -rf /" });
        } catch (err) {
          threw = true;
          errMsg = err.message;
        }
        assertOk(
          threw && errMsg.includes("CommandSecurityError"),
          `Validator rejects destructive command before routing -> ${
            threw ? errMsg : "NO THROW"
          }`
        );
      }
    );
  }

  // -------------------------------------------------------------------------
  // (e) CWD fidelity
  // -------------------------------------------------------------------------
  {
    if (!IS_WINDOWS) {
      console.log("[SKIP] CWD fidelity (not Windows)");
    } else {
      const executor = new ShellExecutorService({ cwd: REPO_ROOT });

      // (e1) POSIX-style cwd is translated with toWindowsPath().
      // Use node -e to read process.cwd() (returns the real Windows path,
      // unlike Git Bash's `pwd` which outputs MSYS2-style /d/... paths).
      await withEnv(
        { QWEN_SHELL_MODE: null, QWEN_POSIX_SHELL: null },
        async () => {
          const res = await executor.execute({
            command: 'node -e "console.log(process.cwd())"',
            cwd: "/mnt/d/LLM_Ecosystem/mcp-qwen",
          });
          const expected = toWindowsPath("/mnt/d/LLM_Ecosystem/mcp-qwen");
          assertOk(
            res.exitCode === 0 &&
              res.stdout.trim().toLowerCase() === expected.toLowerCase(),
            `CWD fidelity: /mnt/d/... -> ${JSON.stringify(
              res.stdout.trim()
            )} (expected ${expected})`
          );
        }
      );

      // (e2) Windows-style cwd is passed verbatim (no translation needed).
      await withEnv(
        { QWEN_SHELL_MODE: null, QWEN_POSIX_SHELL: null },
        async () => {
          const res = await executor.execute({
            command: 'node -e "console.log(process.cwd())"',
            cwd: "D:\\LLM_Ecosystem\\mcp-qwen",
          });
          assertOk(
            res.exitCode === 0 &&
              res.stdout.trim().toLowerCase() === "d:\\llm_ecosystem\\mcp-qwen",
            `CWD fidelity: D:\\... passed verbatim -> ${JSON.stringify(
              res.stdout.trim()
            )}`
          );
        }
      );
    }
  }

  console.log(
    `\n=== posix_routing.test.js: ${passed} passed, ${failed} failed ===`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("posix_routing test failure:", err);
  process.exit(1);
});
