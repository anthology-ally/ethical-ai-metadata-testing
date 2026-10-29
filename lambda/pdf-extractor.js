/**
 * pdfImageParagraphExtractor.js
 *
 * Downloads a PDF from a URL and returns, for every image in the document
 * (in reading order), the index of that image plus the paragraph of text
 * that immediately precedes it.
 *
 * Returns:  Array<{ index: number, page: number, text: string }>
 *   - index: 1-based position of the image among all images in the document
 *   - page:  the page number the image is on
 *   - text:  the paragraph that appears just before the image (may be '' if
 *            the image is the very first thing in the document)
 *
 * Install:
 *   npm install pdfjs-dist
 *
 * Requires Node.js >= 18 (uses the global `fetch`).
 *
 * ---------------------------------------------------------------------------
 * HOW IT WORKS / LIMITATIONS
 * ---------------------------------------------------------------------------
 * PDFs have no real concept of "paragraphs" or reading order - text and
 * images are just drawing instructions with absolute coordinates. This module
 * approximates reading order by:
 *   1. Reading each page's text content and clustering text runs into lines
 *      (by shared y-position) and lines into paragraphs (by vertical gap).
 *   2. Reading each page's operator list (the raw draw commands) and tracking
 *      the current transformation matrix through save/restore/cm operators
 *      to compute where each image is placed on the page (position only -
 *      the pixel data itself is never decoded, which keeps this fast).
 *   3. Merging paragraphs and images by vertical position (top -> bottom) and
 *      remembering the most recent paragraph seen as we walk down the page
 *      (carrying over across page boundaries).
 *
 * This works well for typical single-column documents. It is a heuristic,
 * not a perfect layout engine, so multi-column layouts may interleave
 * paragraphs/images out of the "visual" reading order (this walks purely by
 * y-coordinate), and images placed inside nested Form XObjects (rather than
 * directly in the page's content stream) are not traversed.
 */

'use strict';

// pdfjs-dist (v4+) ships as ESM only, so it's loaded lazily via dynamic
// import() the first time it's needed. This keeps this file itself as plain
// CommonJS while still working on Node >= 18.
let pdfjsLib = null;
async function loadPdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsLib;
}

// ---------------------------------------------------------------------------
// Matrix helpers (PDF affine transforms: [a b c d e f])
// ---------------------------------------------------------------------------

const IDENTITY_MATRIX = [1, 0, 0, 1, 0, 0];

// Combine two matrices such that m1 is applied first, then m2.
function multiplyMatrix(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

function applyMatrix(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// ---------------------------------------------------------------------------
// Text -> lines -> paragraphs
// ---------------------------------------------------------------------------

function groupTextIntoParagraphs(items) {
  const points = items
    .filter((it) => typeof it.str === 'string' && it.str.trim().length > 0)
    .map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      height: it.height || Math.hypot(it.transform[2], it.transform[3]) || 10,
    }));

  if (points.length === 0) return [];

  points.sort((a, b) => b.y - a.y || a.x - b.x);

  // Cluster into lines by y-proximity.
  const lines = [];
  for (const p of points) {
    const tol = Math.max(2, p.height * 0.4);
    let line = lines.find((l) => Math.abs(l.y - p.y) <= tol);
    if (!line) {
      line = { y: p.y, height: p.height, parts: [] };
      lines.push(line);
    }
    line.parts.push(p);
  }

  lines.sort((a, b) => b.y - a.y);
  for (const l of lines) l.parts.sort((a, b) => a.x - b.x);

  const lineTexts = lines
    .map((l) => ({
      y: l.y,
      height: l.height,
      text: l.parts
        .map((p) => p.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    }))
    .filter((l) => l.text.length > 0);

  if (lineTexts.length === 0) return [];

  // Decide paragraph breaks per line-pair using each line's own font size as
  // the reference for "normal" single-line spacing (~1.2-1.3x font size is
  // typical leading). This is more robust than inferring a document-wide
  // line-height, since a page can consist entirely of single-line
  // "paragraphs" with no smaller intra-paragraph gap to learn from.
  const paragraphs = [];
  let current = { yTop: lineTexts[0].y, lines: [lineTexts[0].text] };
  for (let i = 1; i < lineTexts.length; i++) {
    const gap = lineTexts[i - 1].y - lineTexts[i].y;
    const refHeight = Math.max(lineTexts[i - 1].height || 10, lineTexts[i].height || 10);
    const breakThreshold = refHeight * 1.6;
    if (gap > breakThreshold) {
      paragraphs.push(current);
      current = { yTop: lineTexts[i].y, lines: [lineTexts[i].text] };
    } else {
      current.lines.push(lineTexts[i].text);
    }
  }
  paragraphs.push(current);

  return paragraphs.map((p) => ({
    type: 'paragraph',
    y: p.yTop,
    text: p.lines.join(' ').replace(/\s+/g, ' ').trim(),
  }));
}

// ---------------------------------------------------------------------------
// Locate images (position only - pixel data is never fetched or decoded)
// ---------------------------------------------------------------------------

async function findImagePositionsOnPage(page) {
  const OPS = pdfjsLib.OPS;
  const opList = await page.getOperatorList();
  const positions = [];

  let ctm = IDENTITY_MATRIX.slice();
  const stack = [];

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];

    if (fn === OPS.save) {
      stack.push(ctm.slice());
    } else if (fn === OPS.restore) {
      ctm = stack.pop() || IDENTITY_MATRIX.slice();
    } else if (fn === OPS.transform) {
      ctm = multiplyMatrix(args, ctm);
    } else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintJpegXObject ||
      fn === OPS.paintImageMaskXObject
    ) {
      const corners = [
        applyMatrix(ctm, 0, 0),
        applyMatrix(ctm, 1, 0),
        applyMatrix(ctm, 0, 1),
        applyMatrix(ctm, 1, 1),
      ];
      const topY = Math.max(...corners.map((c) => c[1]));
      positions.push({ type: 'image', y: topY });
    }
  }

  return positions;
}

// ---------------------------------------------------------------------------
// Main extraction over the whole document
// ---------------------------------------------------------------------------

async function extractFromBuffer(pdfBuffer) {
  await loadPdfjs();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    useSystemFonts: true,
  });
  const pdfDoc = await loadingTask.promise;

  const results = [];
  let lastParagraphText = '';
  let imageIndex = 0;

  console.log(`PDF has ${pdfDoc.numPages} pages.`);
  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);

    const textContent = await page.getTextContent();
    const paragraphs = groupTextIntoParagraphs(textContent.items);
    const images = await findImagePositionsOnPage(page);

    const merged = [...paragraphs, ...images].sort((a, b) => b.y - a.y);

    for (const item of merged) {
        console.log(`Page ${pageNum} item:`, item);
      if (item.type === 'paragraph') {
        lastParagraphText = item.text;
      } else if (item.type === 'image') {
        results.push({
          index: imageIndex,
          page: pageNum,
          text: lastParagraphText,
        });
        imageIndex += 1;
       
      }
    }

    page.cleanup();
  }

  await loadingTask.destroy();
  return results;
}

async function downloadPdf(url) {
  console.log("Downloading PDF from URL:", url);
  const res = await fetch(url);
  console.log(`Download response: ${res.status} ${res.statusText}`);
  if (!res.ok) {
    throw new Error(`Failed to download PDF: ${res.status} ${res.statusText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Downloads a PDF from `url` and returns an array of
 * { index, page, text } objects, one per image, where `text` is the
 * paragraph preceding that image.
 */
async function extractImagesWithPrecedingText(url) {
  const pdfBuffer = await downloadPdf(url);
  console.log(`Downloaded PDF from ${url}, size: ${pdfBuffer.length} bytes`);
  return await extractFromBuffer(pdfBuffer);
}

module.exports = {
  extractImagesWithPrecedingText,
  extractFromBuffer, // exported for testing / when you already have a Buffer
};
