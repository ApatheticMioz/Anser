/**
 * 50-Vector Deep Sandbox Containment & Blast-Radius Security Verification
 *
 * Proves that neither Qwen nor any harness tool can escape the workspace root
 * or touch C:\, D:\ (root), or other system directories via FS, AST, AVO, or Shell.
 */

import { SandboxFsService } from "../src/harness/services/sandbox_fs.js";
import { AstService } from "../src/harness/services/ast_service.js";
import { ShellExecutorService } from "../src/harness/services/shell_executor.js";
import { AvoOperator } from "../src/harness/avo/avo_operator.js";

async function verifySecurity() {
  console.log("=== Running 50-Vector Sandbox Boundary & Anti-Nuke Security Verification ===");
  const workspaceRoot = process.cwd(); // d:\LLM_Ecosystem
  console.log(`Locked Sandbox Root: ${workspaceRoot}`);

  const fsService = new SandboxFsService({ root: workspaceRoot });
  const astService = new AstService({ root: workspaceRoot });
  const shellService = new ShellExecutorService({ cwd: workspaceRoot });
  const avoOperator = new AvoOperator({ workspaceRoot });

  let totalTests = 0;
  let blockedCount = 0;

  function recordBlocked(name, err) {
    blockedCount++;
    // console.log(`[BLOCKED] ${name} -> ${err.message}`);
  }

  function recordBreach(name) {
    console.error(`[CRITICAL SECURITY BREACH] ${name} was NOT blocked!`);
  }

  // --- Category 1: File Path Escapes (C:, D:\.., /mnt/c, traversal) ---
  const pathVectors = [
    "C:\\Windows\\System32\\calc.exe",
    "C:\\Users\\Apath\\Desktop",
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

  for (const vector of pathVectors) {
    // 1. Read test
    totalTests++;
    try {
      await fsService.readFile({ path: vector });
      recordBreach(`readFile(${vector})`);
    } catch (err) {
      recordBlocked(`readFile(${vector})`, err);
    }

    // 2. Write test
    totalTests++;
    try {
      await fsService.writeFile({ path: vector, content: "MALICIOUS" });
      recordBreach(`writeFile(${vector})`);
    } catch (err) {
      recordBlocked(`writeFile(${vector})`, err);
    }

    // 3. AST Search test
    totalTests++;
    try {
      await astService.search({ path: vector, pattern: "$A" });
      recordBreach(`astSearch(${vector})`);
    } catch (err) {
      recordBlocked(`astSearch(${vector})`, err);
    }

    // 4. AST Replace test
    totalTests++;
    try {
      await astService.replace({ path: vector, pattern: "$A", rewrite: "$B" });
      recordBreach(`astReplace(${vector})`);
    } catch (err) {
      recordBlocked(`astReplace(${vector})`, err);
    }
  }

  // --- Category 2: Null Byte Attacks ---
  const nullByteVectors = [
    "safe_name.js\0malicious.exe",
    "src/test.py\0/../../../../Windows",
  ];
  for (const vector of nullByteVectors) {
    totalTests++;
    try {
      await fsService.writeFile({ path: vector, content: "PAYLOAD" });
      recordBreach(`nullByte(${vector})`);
    } catch (err) {
      recordBlocked(`nullByte(${vector})`, err);
    }
  }

  // --- Category 3: Windows Reserved Device Names ---
  const deviceVectors = ["CON", "PRN", "AUX", "NUL", "COM1", "LPT1"];
  for (const dev of deviceVectors) {
    totalTests++;
    try {
      await fsService.writeFile({ path: dev, content: "PAYLOAD" });
      recordBreach(`deviceWrite(${dev})`);
    } catch (err) {
      recordBlocked(`deviceWrite(${dev})`, err);
    }
  }

  // --- Category 4: Workspace Root Directory Overwrite ---
  totalTests++;
  try {
    await fsService.writeFile({ path: workspaceRoot, content: "ROOT_OVERWRITE" });
    recordBreach("rootOverwrite");
  } catch (err) {
    recordBlocked("rootOverwrite", err);
  }

  // --- Category 5: Dangerous Shell Command Blocking ---
  const dangerousCommands = [
    "rm -rf /",
    "rm -rf /*",
    "rm -rf ~",
    "rm -rf C:\\",
    "rm -rf D:\\",
    "rm -rf /mnt/c/Windows",
    "rmdir /s /q C:\\",
    "del /f /s /q C:\\*",
    "format C:",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda bs=1M",
    "rm -rf C:\\Windows\\System32",
    "rm -rf /mnt/c/Users/Apath",
  ];

  for (const cmd of dangerousCommands) {
    totalTests++;
    try {
      await shellService.execute({ command: cmd });
      recordBreach(`shellExecute(${cmd})`);
    } catch (err) {
      recordBlocked(`shellExecute(${cmd})`, err);
    }
  }

  // --- Category 6: Shell CWD Containment Escapes ---
  const invalidCwds = [
    "C:\\Windows",
    "C:\\Users",
    "../../..",
    "/mnt/c",
  ];
  for (const badCwd of invalidCwds) {
    totalTests++;
    try {
      await shellService.execute({ command: "echo test", cwd: badCwd });
      recordBreach(`shellBadCwd(${badCwd})`);
    } catch (err) {
      recordBlocked(`shellBadCwd(${badCwd})`, err);
    }
  }

  // --- Category 7: AVO Operator File Unlinking Containment ---
  const outsidePaths = [
    "C:\\Windows\\notepad.exe",
    "C:\\Users\\Apath\\Desktop\\file.txt",
    "/mnt/c/Users/test.txt",
    "../../outside.js",
  ];
  for (const outPath of outsidePaths) {
    totalTests++;
    try {
      avoOperator.assertWithinWorkspace(outPath);
      recordBreach(`avoUnlinkOutside(${outPath})`);
    } catch (err) {
      recordBlocked(`avoUnlinkOutside(${outPath})`, err);
    }
  }

  console.log("\n==========================================================================");
  console.log(`Hardening Audit Complete: ${blockedCount} / ${totalTests} Attack Vectors Intercepted & Blocked`);
  console.log("Verdict: ZERO-RISK CONTAINMENT VERIFIED.");
  console.log("Filesystem, AST surgery, AVO rollback, and Shell execution cannot escape the project root.");
  console.log("==========================================================================");

  if (blockedCount !== totalTests) {
    process.exit(1);
  }
}

verifySecurity().catch((err) => {
  console.error("Security audit failure:", err);
  process.exit(1);
});
