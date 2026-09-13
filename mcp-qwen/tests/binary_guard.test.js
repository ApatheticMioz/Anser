/**
 * M2 — Binary-file guard tests (2026-09-13 "poison pill" mitigation).
 *
 * Pins down the fail-fast / honest-skip invariants of SandboxFsService that
 * keep binary content (PDF/PNG/...) out of a text-only model's context:
 *
 *   (a) readFile rejects a .pdf with an explicit BinaryFileError naming the
 *       file, the detected type, and the "extract via bash" instruction.
 *   (b) readFile rejects a .png the same way.
 *   (c) readFile still returns a normal text file (no false positive).
 *   (d) readFile catches an EXTENSIONLESS binary (content starts with %PDF)
 *       via the magic-byte check (file-type), not the extension denylist.
 *   (e) searchCode's fallback walk reports binary files as "skipped-binary"
 *       (honest skip) instead of ingesting mojibake, while still returning
 *       the text-file matches.
 *
 * Uses Node's native test runner (node:test) and strict assertions
 * (node:assert/strict). All fixtures are created in os.tmpdir() (a
 * non-git location, so searchCode takes the fallback walk) and cleaned up.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  SandboxFsService,
  BinaryFileError,
  isBinaryExtension,
} from "../src/harness/services/sandbox_fs.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const tmpDirs = [];

function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** A minimal but valid-enough PDF: %PDF magic + a few binary bytes. */
function makePdfBytes() {
  return Buffer.from(
    "%PDF-1.4\n% \u0000\u0001\u0002\u0003 binary body \u0000\u0000",
    "latin1"
  );
}

/** A minimal PNG: 8-byte signature + an IHDR chunk (what file-type needs). */
function makePngBytes() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]), // IHDR length
    Buffer.from("IHDR", "latin1"),
    Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]), // 1x1, 8-bit RGB
  ]);
}

after(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ---------------------------------------------------------------------------
// (a) readFile rejects a .pdf with an explicit, actionable error
// ---------------------------------------------------------------------------

test("M2: readFile rejects a .pdf with a BinaryFileError naming file + type + bash instruction", async () => {
  const dir = makeTmpDir("m2_pdf_");
  const pdfPath = path.join(dir, "report.pdf");
  fs.writeFileSync(pdfPath, makePdfBytes());

  const svc = new SandboxFsService({ root: dir });
  await assert.rejects(
    () => svc.readFile({ path: "report.pdf" }),
    (err) => {
      assert.ok(
        err instanceof BinaryFileError,
        `expected BinaryFileError, got ${err.name}: ${err.message}`
      );
      assert.equal(err.name, "BinaryFileError");
      // Names the file.
      assert.ok(
        err.message.includes("report.pdf"),
        `error should name the file: ${err.message}`
      );
      // Names the detected type (mime + ext).
      assert.ok(
        err.message.includes("application/pdf") && err.message.includes(".pdf"),
        `error should name the detected type: ${err.message}`
      );
      // Instructs to extract text via bash tooling instead.
      assert.ok(
        /bash tool/i.test(err.message) && /pdftotext|extract/i.test(err.message),
        `error should instruct to extract text via bash: ${err.message}`
      );
      // Structured fields are populated.
      assert.equal(err.detectedType, "application/pdf (.pdf)");
      assert.ok(err.file.endsWith("report.pdf"), `err.file: ${err.file}`);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// (b) readFile rejects a .png
// ---------------------------------------------------------------------------

test("M2: readFile rejects a .png with a BinaryFileError", async () => {
  const dir = makeTmpDir("m2_png_");
  const pngPath = path.join(dir, "icon.png");
  fs.writeFileSync(pngPath, makePngBytes());

  const svc = new SandboxFsService({ root: dir });
  await assert.rejects(
    () => svc.readFile({ path: "icon.png" }),
    (err) => {
      assert.ok(
        err instanceof BinaryFileError,
        `expected BinaryFileError, got ${err.name}: ${err.message}`
      );
      assert.ok(
        err.message.includes("icon.png"),
        `error should name the file: ${err.message}`
      );
      assert.ok(
        err.message.includes("image/png") && err.message.includes(".png"),
        `error should name the detected type: ${err.message}`
      );
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// (c) readFile still returns a normal text file (no false positive)
// ---------------------------------------------------------------------------

test("M2: readFile still returns a normal text file (no false positive)", async () => {
  const dir = makeTmpDir("m2_text_");
  const txtPath = path.join(dir, "notes.txt");
  // No trailing newline so split("\n") yields exactly 3 lines.
  fs.writeFileSync(txtPath, "hello\nworld\nthis is plain text", "utf8");

  const svc = new SandboxFsService({ root: dir });
  const res = await svc.readFile({ path: "notes.txt" });

  assert.equal(res.path, txtPath);
  assert.equal(res.total_lines, 3);
  assert.ok(res.content.includes("1: hello"), `content: ${res.content}`);
  assert.ok(res.content.includes("3: this is plain text"), `content: ${res.content}`);
});

// ---------------------------------------------------------------------------
// (d) readFile catches an EXTENSIONLESS binary via magic bytes
// ---------------------------------------------------------------------------

test("M2: readFile catches an extensionless binary (starts with %PDF) via magic bytes", async () => {
  const dir = makeTmpDir("m2_extless_");
  // No extension at all — the extension denylist CANNOT catch this; only the
  // magic-byte check can.
  const blobPath = path.join(dir, "mystery_blob");
  fs.writeFileSync(blobPath, makePdfBytes());

  // Sanity: the extension denylist must NOT flag this (no extension).
  assert.equal(isBinaryExtension("mystery_blob"), false);

  const svc = new SandboxFsService({ root: dir });
  await assert.rejects(
    () => svc.readFile({ path: "mystery_blob" }),
    (err) => {
      assert.ok(
        err instanceof BinaryFileError,
        `expected BinaryFileError, got ${err.name}: ${err.message}`
      );
      // The magic-byte check identified it as a PDF.
      assert.ok(
        err.message.includes("application/pdf") && err.message.includes(".pdf"),
        `error should name the magic-byte-detected type: ${err.message}`
      );
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// (e) searchCode fallback walk reports binaries as skipped-binary
// ---------------------------------------------------------------------------

test("M2: searchCode fallback walk reports binary files as skipped-binary (honest skip)", async () => {
  const dir = makeTmpDir("m2_search_");
  // NON-git dir -> fallback walk.
  // A text file that contains the query.
  fs.writeFileSync(path.join(dir, "code.txt"), "needle in the haystack\n", "utf8");
  // A PDF and a PNG that also contain the literal query bytes (so a naive
  // UTF-8 read WOULD have matched and ingested mojibake).
  const pdfWithQuery = Buffer.concat([
    makePdfBytes(),
    Buffer.from("needle in the haystack\n", "latin1"),
  ]);
  fs.writeFileSync(path.join(dir, "doc.pdf"), pdfWithQuery);
  const pngWithQuery = Buffer.concat([
    makePngBytes(),
    Buffer.from("needle in the haystack\n", "latin1"),
  ]);
  fs.writeFileSync(path.join(dir, "img.png"), pngWithQuery);

  const svc = new SandboxFsService({ root: dir });
  const res = await svc.searchCode({ query: "needle", dirPath: "." });

  // The text file is still found.
  assert.ok(
    res.matches.some((m) => m.includes("code.txt")),
    `text file should be found: ${JSON.stringify(res.matches)}`
  );
  // The binaries are NOT ingested as matches.
  assert.ok(
    !res.matches.some((m) => m.includes("doc.pdf")),
    `PDF must NOT be ingested as a match: ${JSON.stringify(res.matches)}`
  );
  assert.ok(
    !res.matches.some((m) => m.includes("img.png")),
    `PNG must NOT be ingested as a match: ${JSON.stringify(res.matches)}`
  );
  // The binaries are reported honestly as skipped-binary.
  assert.ok(Array.isArray(res.skipped), "result should include a skipped array");
  assert.ok(
    res.skipped.some((s) => s.includes("doc.pdf") && s.includes("skipped-binary")),
    `PDF should be reported as skipped-binary: ${JSON.stringify(res.skipped)}`
  );
  assert.ok(
    res.skipped.some((s) => s.includes("img.png") && s.includes("skipped-binary")),
    `PNG should be reported as skipped-binary: ${JSON.stringify(res.skipped)}`
  );
  // count reflects only the real (text) matches.
  assert.equal(
    res.count,
    res.matches.length,
    "count should equal the number of returned matches"
  );
});

test("M2: searchCode fallback walk catches an extensionless binary via magic bytes", async () => {
  const dir = makeTmpDir("m2_search_extless_");
  // NON-git dir -> fallback walk.
  fs.writeFileSync(path.join(dir, "code.txt"), "needle here\n", "utf8");
  // Extensionless file whose content starts with %PDF and contains the query.
  const blob = Buffer.concat([
    makePdfBytes(),
    Buffer.from("needle here\n", "latin1"),
  ]);
  fs.writeFileSync(path.join(dir, "raw_blob"), blob);

  const svc = new SandboxFsService({ root: dir });
  const res = await svc.searchCode({ query: "needle", dirPath: "." });

  assert.ok(
    res.matches.some((m) => m.includes("code.txt")),
    `text file should be found: ${JSON.stringify(res.matches)}`
  );
  assert.ok(
    !res.matches.some((m) => m.includes("raw_blob")),
    `extensionless binary must NOT be ingested: ${JSON.stringify(res.matches)}`
  );
  assert.ok(
    res.skipped.some((s) => s.includes("raw_blob") && s.includes("skipped-binary")),
    `extensionless binary should be reported as skipped-binary: ${JSON.stringify(res.skipped)}`
  );
});
