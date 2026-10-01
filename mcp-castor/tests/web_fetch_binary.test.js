/**
 * web_fetch binary-safety gate & in-process PDF extraction tests.
 *
 * Verifies:
 *   1. A PDF response (application/pdf) is text-extracted in-process via
 *      pdf-parse and returned as clean text — never raw %PDF- bytes.
 *   2. A PDF served with a misleading Content-Type is still detected via the
 *      %PDF- magic bytes and text-extracted.
 *   3. Binary media (image/png, application/zip) returns a structured stub
 *      (binary:true, byte_length) with no UTF-8 mojibake in the markdown.
 *   4. An unknown-type body containing NUL bytes is stubbed as binary.
 *   5. Text / JSON / HTML responses continue through their existing pipelines
 *      (no false-positive binary classification).
 *
 * Uses a local mock HTTP server for deterministic offline testing and
 * node:assert/strict.
 */

import http from "node:http";
import assert from "node:assert/strict";
import { WebService } from "../src/harness/services/web_service.js";

// ---------------------------------------------------------------------------
// Fixture: a minimal but valid single-page PDF containing known text.
// ---------------------------------------------------------------------------
function makePdfBytes() {
  const content = "BT /F1 24 Tf 72 720 Td (Hello PDF World) Tj ET";
  const objs = [];
  objs[1] = "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj";
  objs[2] = "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj";
  objs[3] =
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj";
  objs[4] = `4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`;
  objs[5] = "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj";

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = pdf.length;
    pdf += objs[i] + "\n";
  }
  const xrefPos = pdf.length;
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) {
    pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  pdf += `trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

// A minimal PNG: 8-byte signature + IHDR chunk.
function makePngBytes() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from("IHDR", "latin1"),
    Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
  ]);
}

// A ZIP: PK\x03\x04 local-file-header magic + a NUL byte.
function makeZipBytes() {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from("dummy", "latin1"),
  ]);
}

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) {
    console.log(`  [PASS] ${name}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${name}`);
    failed++;
  }
}

async function run() {
  console.log("=== web_fetch Binary-Safety & PDF Extraction Tests ===\n");

  const pdfBytes = makePdfBytes();
  const pngBytes = makePngBytes();
  const zipBytes = makeZipBytes();
  const nulBytes = Buffer.concat([Buffer.from("head"), Buffer.from([0, 0, 0]), Buffer.from("tail")]);

  const mockServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${mockServer.address().port}`);
    switch (url.pathname) {
      case "/doc.pdf":
        res.writeHead(200, { "Content-Type": "application/pdf" });
        res.end(pdfBytes);
        break;
      case "/mislabeled.pdf":
        // Deliberately wrong Content-Type; magic bytes must still detect PDF.
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(pdfBytes);
        break;
      case "/image.png":
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(pngBytes);
        break;
      case "/archive.zip":
        res.writeHead(200, { "Content-Type": "application/zip" });
        res.end(zipBytes);
        break;
      case "/unknown-nul":
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(nulBytes);
        break;
      case "/notes.txt":
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Plain text note line one\nline two");
        break;
      case "/data.json":
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", n: 42 }));
        break;
      case "/article":
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<!DOCTYPE html><html><head><title>Article</title></head><body>` +
            `<article><h1>Article Title</h1><p>Body paragraph with content.</p></article>` +
            `</body></html>`
        );
        break;
      default:
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
    }
  });

  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${mockServer.address().port}`;
  const web = new WebService();

  try {
    // -------------------------------------------------------------------------
    // 1. PDF with correct Content-Type → in-process text extraction
    // -------------------------------------------------------------------------
    console.log("[1] PDF (application/pdf) text extraction");
    {
      const res = await web.fetch({ url: `${baseUrl}/doc.pdf` });
      ok(res.content_type === "application/pdf", "content_type is application/pdf");
      ok(res.markdown.includes("Hello PDF World"), `extracted text present: ${JSON.stringify(res.markdown)}`);
      ok(!res.markdown.includes("%PDF-"), "no raw %PDF- magic bytes in output");
      ok(!res.binary, "not flagged as binary stub");
      ok(typeof res.length === "number" && res.length > 0, "length reflects extracted text");
    }

    // -------------------------------------------------------------------------
    // 2. PDF with misleading Content-Type → magic-byte detection
    // -------------------------------------------------------------------------
    console.log("[2] PDF (mislabeled octet-stream) magic-byte detection");
    {
      const res = await web.fetch({ url: `${baseUrl}/mislabeled.pdf` });
      ok(res.content_type === "application/pdf", "detected as PDF via magic bytes");
      ok(res.markdown.includes("Hello PDF World"), "text extracted despite wrong header");
      ok(!res.markdown.includes("%PDF-"), "no raw %PDF- magic bytes in output");
    }

    // -------------------------------------------------------------------------
    // 3. Binary media (image/png) → structured stub, no UTF-8 corruption
    // -------------------------------------------------------------------------
    console.log("[3] Binary media (image/png) stub");
    {
      const res = await web.fetch({ url: `${baseUrl}/image.png` });
      ok(res.binary === true, "flagged as binary");
      ok(res.content_type === "image/png", "content_type preserved");
      ok(res.byte_length === pngBytes.length, `byte_length matches (${res.byte_length})`);
      ok(res.markdown.includes("Binary content"), "markdown is a stub message");
      ok(!res.markdown.includes("\u0000"), "no NUL bytes in markdown");
      ok(!res.markdown.includes("\ufffd"), "no UTF-8 replacement chars (no mojibake)");
    }

    // -------------------------------------------------------------------------
    // 4. Binary media (application/zip) → structured stub
    // -------------------------------------------------------------------------
    console.log("[4] Binary media (application/zip) stub");
    {
      const res = await web.fetch({ url: `${baseUrl}/archive.zip` });
      ok(res.binary === true, "flagged as binary");
      ok(res.content_type === "application/zip", "content_type preserved");
      ok(res.byte_length === zipBytes.length, "byte_length matches");
      ok(!res.markdown.includes("\ufffd"), "no UTF-8 replacement chars");
    }

    // -------------------------------------------------------------------------
    // 5. Unknown-type body with NUL bytes → stubbed as binary
    // -------------------------------------------------------------------------
    console.log("[5] Unknown-type body with NUL bytes → binary stub");
    {
      const res = await web.fetch({ url: `${baseUrl}/unknown-nul` });
      ok(res.binary === true, "NUL-byte body flagged as binary");
      ok(res.byte_length === nulBytes.length, "byte_length matches");
      ok(!res.markdown.includes("\u0000"), "no NUL bytes in markdown");
    }

    // -------------------------------------------------------------------------
    // 6. Text / JSON / HTML continue through existing pipelines (no false positive)
    // -------------------------------------------------------------------------
    console.log("[6] Text / JSON / HTML pass-through (no false-positive binary)");
    {
      const txt = await web.fetch({ url: `${baseUrl}/notes.txt` });
      ok(txt.content_type === "text/plain", "text/plain preserved");
      ok(txt.markdown.includes("Plain text note"), "text content intact");
      ok(!txt.binary, "text not flagged binary");

      const js = await web.fetch({ url: `${baseUrl}/data.json` });
      ok(js.content_type === "application/json", "application/json preserved");
      ok(js.markdown.includes('"status": "ok"'), "JSON content intact");
      ok(!js.binary, "JSON not flagged binary");

      const html = await web.fetch({ url: `${baseUrl}/article`, extract_article: true });
      ok(html.content_type === "article", "HTML article extracted");
      ok(html.markdown.includes("Body paragraph with content"), "article body intact");
      ok(!html.binary, "HTML not flagged binary");
    }
  } finally {
    mockServer.close();
  }

  console.log("\n==========================================");
  console.log(`web_fetch Binary/PDF Tests: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================");

  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Unhandled error in test runner:", err);
  process.exit(1);
});
