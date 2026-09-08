/**
 * Platform Abstraction & Portability (P3) — OFFLINE verification.
 *
 * No live engine, no live WSL dispatch. The whoami probe is mocked via the
 * setWslUserProbe seam; every resolver is exercised with env overrides and
 * defaults. buildSpawnProfile is checked for its exact windows/wsl shape.
 *
 *   (a) env overrides win for every resolver
 *   (b) defaults when env is unset (mocked whoami probe)
 *   (c) buildSpawnProfile: windows mode (direct) vs wsl mode (wrapper + cwd
 *       translated)
 *   (d) streamProxyPath resolves to the /mnt/d/... form of the repo's
 *       stream_proxy.js regardless of process.cwd()
 *   (e) no path resolution throws when WSL is unavailable (probe failure)
 */

import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const {
  wslDistro,
  wslUser,
  wslHome,
  winHome,
  winHomeWsl,
  gooseBin,
  streamProxyPath,
  stateDir,
  apiKeyCandidates,
  buildSpawnProfile,
  setWslUserProbe,
  _resetWslUserCache,
  toPosixWslPath,
  toWindowsPath,
  resolveCommandPath,
  _resetCommandPathCache,
} = await import("../src/platform.js");

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

// ---------------------------------------------------------------------------
// (a) env overrides win
// ---------------------------------------------------------------------------
{
  const saved = { ...process.env };
  try {
    process.env.QWEN_WSL_DISTRO = "Debian";
    process.env.QWEN_WSL_USER = "alice";
    process.env.QWEN_WSL_HOME = "/home/alice";
    process.env.QWEN_GOOSE_BIN = "/opt/goose/bin/goose";
    process.env.QWEN_STREAM_PROXY_PATH = "/custom/stream_proxy.js";
    process.env.QWEN_WIN_HOME = "C:\\Users\\alice";
    process.env.QWEN_WIN_HOME_WSL = "/mnt/c/Users/alice";

    assertOk(wslDistro() === "Debian", "env: QWEN_WSL_DISTRO wins");
    assertOk(wslUser() === "alice", "env: QWEN_WSL_USER wins");
    assertOk(wslHome() === "/home/alice", "env: QWEN_WSL_HOME wins");
    assertOk(gooseBin() === "/opt/goose/bin/goose", "env: QWEN_GOOSE_BIN wins");
    assertOk(
      streamProxyPath() === "/custom/stream_proxy.js",
      "env: QWEN_STREAM_PROXY_PATH wins"
    );
    assertOk(winHome() === "C:\\Users\\alice", "env: QWEN_WIN_HOME wins");
    assertOk(winHomeWsl() === "/mnt/c/Users/alice", "env: QWEN_WIN_HOME_WSL wins");
  } finally {
    process.env = saved;
  }
}

// ---------------------------------------------------------------------------
// (b) defaults when env is unset (mocked whoami probe)
// ---------------------------------------------------------------------------
{
  const saved = { ...process.env };
  try {
    delete process.env.QWEN_WSL_DISTRO;
    delete process.env.QWEN_WSL_USER;
    delete process.env.QWEN_WSL_HOME;
    delete process.env.QWEN_GOOSE_BIN;
    delete process.env.QWEN_STREAM_PROXY_PATH;
    delete process.env.QWEN_WIN_HOME;
    delete process.env.QWEN_WIN_HOME_WSL;

    assertOk(wslDistro() === "Ubuntu", "default: wslDistro() === Ubuntu");

    // Mock a successful whoami probe -> user "bob", home derived /home/bob.
    _resetWslUserCache();
    setWslUserProbe(() => "bob");
    assertOk(wslUser() === "bob", "default: wslUser() from mocked whoami");
    assertOk(wslHome() === "/home/bob", "default: wslHome() derived from user");

    // Mock a FAILED whoami probe -> falls back to root / /root without throwing.
    _resetWslUserCache();
    setWslUserProbe(() => {
      throw new Error("wsl.exe not found");
    });
    assertOk(wslUser() === "root", "default: wslUser() falls back to root on probe failure");
    assertOk(wslHome() === "/root", "default: wslHome() falls back to /root on probe failure");

    // Restore the real probe for the rest of the suite.
    setWslUserProbe(null);
    _resetWslUserCache();
  } finally {
    process.env = saved;
  }
}

// ---------------------------------------------------------------------------
// (c) buildSpawnProfile: windows vs wsl shape
// ---------------------------------------------------------------------------
{
  const saved = { ...process.env };
  try {
    delete process.env.QWEN_WSL_DISTRO;
    delete process.env.QWEN_WSL_USER;
    delete process.env.QWEN_WSL_HOME;

    // Windows mode: spawn the command directly, cwd passed through as-is.
    const win = buildSpawnProfile({
      command: "goose",
      args: ["run", "--name", "s1"],
      cwd: "D:\\LLM_Ecosystem\\mcp-qwen",
      env: { GOOSE_PROVIDER: "openai" },
      mode: "windows",
    });
    assertOk(win.command === "goose", "windows: command is the raw command");
    assertOk(
      JSON.stringify(win.args) === JSON.stringify(["run", "--name", "s1"]),
      "windows: args preserved"
    );
    assertOk(
      win.options.cwd === "D:\\LLM_Ecosystem\\mcp-qwen",
      "windows: cwd passed through as-is"
    );
    assertOk(win.options.env.GOOSE_PROVIDER === "openai", "windows: env merged");
    assertOk(
      JSON.stringify(win.options.stdio) === JSON.stringify(["ignore", "pipe", "pipe"]),
      "windows: stdio defaults to ignore/pipe/pipe (never inherit)"
    );

    // WSL mode: wrap with wsl.exe -d <distro> --cd <posixCwd> --exec <cmd>.
    const wsl = buildSpawnProfile({
      command: "goose",
      args: ["run", "--name", "s1"],
      cwd: "D:\\LLM_Ecosystem\\mcp-qwen",
      env: { GOOSE_PROVIDER: "openai" },
      mode: "wsl",
    });
    assertOk(wsl.command === "wsl.exe", "wsl: command is wsl.exe");
    assertOk(wsl.args[0] === "-d" && wsl.args[1] === "Ubuntu", "wsl: -d <distro> present");
    assertOk(
      wsl.args.includes("--cd") &&
        wsl.args[wsl.args.indexOf("--cd") + 1] === "/mnt/d/LLM_Ecosystem/mcp-qwen",
      "wsl: --cd <translated posix cwd> present"
    );
    const execIdx = wsl.args.indexOf("--exec");
    assertOk(
      execIdx !== -1 &&
        wsl.args[execIdx + 1] === "goose" &&
        JSON.stringify(wsl.args.slice(execIdx + 2)) ===
          JSON.stringify(["run", "--name", "s1"]),
      "wsl: --exec <cmd> <args...> present"
    );
    assertOk(wsl.options.env.GOOSE_PROVIDER === "openai", "wsl: env merged");
    assertOk(
      JSON.stringify(wsl.options.stdio) === JSON.stringify(["ignore", "pipe", "pipe"]),
      "wsl: stdio defaults to ignore/pipe/pipe (never inherit)"
    );
    assertOk(wsl.options.detached === false, "wsl: detached=false (wsl.exe wrapper)");

    // WSL mode with an explicit --user.
    const wslUserProfile = buildSpawnProfile({
      command: "bash",
      args: ["-c", "echo hi"],
      cwd: "/mnt/d/LLM_Ecosystem/mcp-qwen",
      mode: "wsl",
      user: "bob",
    });
    const uIdx = wslUserProfile.args.indexOf("--user");
    assertOk(
      uIdx !== -1 && wslUserProfile.args[uIdx + 1] === "bob",
      "wsl: --user <user> present when requested"
    );
    // A POSIX cwd is left as-is by the translator.
    assertOk(
      wslUserProfile.args[wslUserProfile.args.indexOf("--cd") + 1] ===
        "/mnt/d/LLM_Ecosystem/mcp-qwen",
      "wsl: posix cwd preserved"
    );
  } finally {
    process.env = saved;
  }
}

// ---------------------------------------------------------------------------
// (d) streamProxyPath resolves to the /mnt/d/... form regardless of cwd
// ---------------------------------------------------------------------------
{
  const saved = { ...process.env };
  try {
    delete process.env.QWEN_STREAM_PROXY_PATH;
    const p = streamProxyPath();
    assertOk(
      p === "/mnt/d/LLM_Ecosystem/mcp-qwen/stream_proxy.js",
      `streamProxyPath() === /mnt/d/.../stream_proxy.js (got ${p})`
    );
    // Prove it is derived from import.meta.url, not process.cwd(): change cwd
    // and confirm the value is unchanged.
    const before = process.cwd();
    try {
      process.chdir(REPO_ROOT);
      assertOk(
        streamProxyPath() === p,
        "streamProxyPath() stable across process.cwd() change"
      );
    } finally {
      process.chdir(before);
    }
  } finally {
    process.env = saved;
  }
}

// ---------------------------------------------------------------------------
// (e) no path resolution throws when WSL is unavailable
// ---------------------------------------------------------------------------
{
  const saved = { ...process.env };
  try {
    delete process.env.QWEN_WSL_USER;
    delete process.env.QWEN_WSL_HOME;
    _resetWslUserCache();
    setWslUserProbe(() => {
      throw new Error("ENOENT: wsl.exe");
    });
    let threw = false;
    let u, h;
    try {
      u = wslUser();
      h = wslHome();
    } catch {
      threw = true;
    }
    assertOk(!threw, "no throw when WSL probe fails");
    assertOk(u === "root" && h === "/root", "safe fallback root//root when WSL unavailable");
    setWslUserProbe(null);
    _resetWslUserCache();
  } finally {
    process.env = saved;
  }
}

// ---------------------------------------------------------------------------
// (f) re-exported translators + apiKeyCandidates + stateDir sanity
// ---------------------------------------------------------------------------
{
  assertOk(
    toPosixWslPath("D:\\LLM_Ecosystem\\mcp-qwen") === "/mnt/d/LLM_Ecosystem/mcp-qwen",
    "re-export: toPosixWslPath translates a Windows path"
  );
  assertOk(
    toWindowsPath("/mnt/d/LLM_Ecosystem/mcp-qwen") === "D:\\LLM_Ecosystem\\mcp-qwen",
    "re-export: toWindowsPath translates a POSIX path"
  );

  const saved = { ...process.env };
  try {
    delete process.env.QWEN_WSL_DISTRO;
    delete process.env.QWEN_WSL_USER;
    delete process.env.QWEN_WSL_HOME;
    delete process.env.QWEN_WIN_HOME;
    delete process.env.QWEN_WIN_HOME_WSL;
    _resetWslUserCache();
    setWslUserProbe(() => "testuser");
    const cands = apiKeyCandidates();
    assertOk(
      cands.some((c) => c.includes("qwen-serving") && c.includes("api_key.txt")),
      "apiKeyCandidates() yields qwen-serving/api_key.txt paths"
    );
    assertOk(
      cands.every((c) => !c.includes("\\\\home") && !c.includes("home\\\\testuser")),
      "apiKeyCandidates() has no double-backslash home segment"
    );
    setWslUserProbe(null);
    _resetWslUserCache();
    assertOk(typeof stateDir() === "string" && stateDir().length > 0, "stateDir() re-exported");
  } finally {
    process.env = saved;
  }
}

// ---------------------------------------------------------------------------
// (f) P8 bridge close-out: resolveCommandPath — bare names resolve to spawnable
// absolute paths (Windows .cmd shims are not spawnable without this); absolute
// and path-bearing commands pass through untouched; garbage degrades to null.
// ---------------------------------------------------------------------------
function testResolveCommandPath() {
  _resetCommandPathCache();
  const abs = resolveCommandPath("node");
  assertOk(
    typeof abs === "string" && path.isAbsolute(abs),
    `bare 'node' resolves to an absolute spawnable path (got: ${abs})`
  );
  const passthrough = resolveCommandPath("D:\\some\\dir\\tool.cmd");
  assertOk(
    passthrough === "D:\\some\\dir\\tool.cmd",
    "path-bearing command passes through untouched"
  );
  const unixish = resolveCommandPath("/usr/local/bin/tool");
  assertOk(unixish === "/usr/local/bin/tool", "absolute posix path passes through untouched");
  assertOk(resolveCommandPath("") === null, "empty command -> null");
  assertOk(resolveCommandPath(null) === null, "null command -> null");
  const cacheProbe = resolveCommandPath("node");
  assertOk(
    cacheProbe === abs,
    "resolution is cached (second probe returns the same path)"
  );
  _resetCommandPathCache();
}

try {
  testResolveCommandPath();
} catch (err) {
  failed++;
  console.log(`[FAIL] resolveCommandPath: ${err.message}`);
}

console.log(`\n=== platform.test.js: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
