#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const isWin = process.platform === "win32";
const args = process.argv.slice(2);

const releasePath = path.join(root, "target", "release", "castor");
const debugPath = path.join(root, "target", "debug", "castor");

if (isWin) {
  const wslRoot = root
    .replace(/^([a-zA-Z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)
    .replace(/\\/g, "/");

  let wslBin = "castor";
  if (fs.existsSync(releasePath)) {
    wslBin = `${wslRoot}/target/release/castor`;
  } else if (fs.existsSync(debugPath)) {
    wslBin = `${wslRoot}/target/debug/castor`;
  }

  const child = spawn("wsl.exe", ["--", wslBin, ...args], {
    stdio: "inherit",
    windowsHide: true,
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
} else {
  let bin = "castor";
  if (fs.existsSync(releasePath)) {
    bin = releasePath;
  } else if (fs.existsSync(debugPath)) {
    bin = debugPath;
  }

  const child = spawn(bin, args, { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}
