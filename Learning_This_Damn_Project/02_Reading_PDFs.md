# Phase 2: Reading PDFs in the Browser

> **Goal:** The very first real feature. A user drops a PDF file. We need to extract all the text from it — page by page — entirely inside the browser. No server, no upload. By the end, you should be able to write `PDFExtractor.ts` from memory.

---

## What Problem Are We Solving?

A PDF file is NOT plain text. It's a complex binary format that contains:
- Fonts, images, vector graphics
- Text positioned at specific X/Y coordinates on the page
- Compression, encryption, metadata

You can't just `file.text()` a PDF. You need a library that understands the PDF format.

```
PDF File (binary)                          Extracted Text
┌────────────────────┐                    ┌──────────────────────┐
│ %PDF-1.7            │                    │ Employee Report       │
│ 3 0 obj             │   ──── pdf.js ──▶  │                      │
│ <</Type /Page        │                    │ Name: Rahul Sharma   │
│ /Contents 4 0 R     │                    │ Email: rahul@co.com  │
│ stream              │                    │ Salary: ₹25,00,000  │
│ BT /F1 12 Tf        │                    │                      │
│ 100 700 Td          │                    │ Department: Finance  │
│ (Employee Report) Tj│                    │ ...                  │
│ ...                 │                    └──────────────────────┘
└────────────────────┘
```

---

## What is pdf.js?

**pdf.js** is Mozilla's PDF rendering engine. It's the same engine that Firefox uses to display PDFs. It's written entirely in JavaScript and runs in the browser.

We use it for **text extraction** (not rendering). It reads the PDF binary, finds all the text elements, and gives us their content and position on the page.

### Why pdf.js Over Alternatives?

| Library | Runs in Browser? | Can Extract Text? | Why Not? |
|---------|:-:|:-:|---------|
| **pdf.js** ✅ | Yes | Yes | Our choice |
| `pdf-parse` | ❌ No (Node.js) | Yes | Needs a server |
| `pdfplumber` | ❌ No (Python) | Yes | Different language entirely |
| `Apache Tika` | ❌ No (Java) | Yes | Server-side only |

pdf.js is the ONLY mature option for client-side PDF text extraction.

---

## Building `PDFExtractor.ts` — Step by Step

Let's pretend we're writing this from scratch.

### Step 1: Import and Configure pdf.js

```typescript
// pdf.js has two parts:
// 1. The main library (pdfjsLib) — provides the API
// 2. A web worker script — does the actual PDF parsing in a background thread
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url';

// Tell pdf.js where its worker script lives
// The `?url` suffix is a Vite feature — it returns the URL of the file
// instead of importing it as code
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;
```

> **Why does pdf.js use a Web Worker?**
> PDF parsing is CPU-intensive. If it ran on the main thread, your UI would freeze while parsing a 200-page document. pdf.js offloads the heavy parsing to a background thread automatically.

### Step 2: Define the Data Structures

Before writing logic, define what data goes in and comes out:

```typescript
// What a single text element from the PDF looks like internally
interface PDFTextItem {
  str: string;            // The actual text content (e.g., "Rahul")
  transform: number[];    // 6-element array. transform[5] = Y position on page
  hasEOL?: boolean;       // Does this item end with a newline?
}

// What we return for each page
export interface ExtractedPDFPage {
  pageNumber: number;     // 1-indexed page number
  text: string;           // All text from this page, joined into lines
}

// What we return for the entire PDF
export interface PDFExtractionResult {
  fileName: string;       // Original file name (e.g., "report.pdf")
  pageCount: number;      // Total number of pages
  pages: ExtractedPDFPage[];  // Array of page results
  fullText: string;       // All pages joined with \n\n between them
}
```

### Step 3: The Main `extract()` Method

```typescript
export class PDFExtractor {

  // STATIC method — you call PDFExtractor.extract(file), not new PDFExtractor().extract()
  // Why static? Because PDFExtractor has no instance state. It's a pure utility.
  static async extract(file: File): Promise<PDFExtractionResult> {

    // VALIDATION: Only accept PDF files
    // Check both MIME type and file extension (belt and suspenders)
    if (
      file.type !== 'application/pdf' &&
      !file.name.toLowerCase().endsWith('.pdf')
    ) {
      throw new Error('PDFExtractor only accepts PDF files.');
    }

    // STEP 1: Read the file into raw bytes
    // Files in the browser are Blob objects — we need ArrayBuffer for pdf.js
    const arrayBuffer = await this.readFileAsArrayBuffer(file);

    // STEP 2: Give the bytes to pdf.js to parse
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),  // The PDF bytes
      useWorkerFetch: false,               // Don't let the worker fetch network resources
      isEvalSupported: false,              // Security: disable eval() inside pdf.js
      stopAtErrors: true                   // Don't silently skip corrupt pages
    });

    // Wait for pdf.js to finish parsing the document structure
    const pdf = await loadingTask.promise;

    try {
      const pages: ExtractedPDFPage[] = [];

      // STEP 3: Extract text from each page, one at a time
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const text = await this.extractPageText(page);
        pages.push({ pageNumber, text });
        page.cleanup();  // Free memory for this page
      }

      return {
        fileName: file.name,
        pageCount: pdf.numPages,
        pages,
        // Join all pages with double newlines between them
        fullText: pages.map((page) => page.text).join('\n\n')
      };
    } finally {
      // ALWAYS clean up the PDF document, even if extraction fails
      await pdf.destroy();
    }
  }
```

> **Design Decision: Why `try/finally`?**
> `pdf.destroy()` frees WASM memory. If we forget to call it, we leak memory. `try/finally` guarantees cleanup even if an error is thrown during extraction. This is a common pattern for resource management.

### Step 4: Extracting Text from a Single Page (The Tricky Part)

This is where the interesting engineering happens. pdf.js gives us individual text items with X/Y positions. We need to reconstruct **lines of text** from these scattered items.

```
PDF internally stores text like this:

  Item 1: "Employee"    at position (100, 700)
  Item 2: "Report"      at position (180, 700)   ← same Y = same line
  Item 3: "Name:"       at position (100, 680)   ← different Y = new line
  Item 4: "Rahul"       at position (160, 680)   ← same Y = same line
  Item 5: "Sharma"      at position (200, 680)   ← same Y = same line

We need to produce:
  "Employee Report"
  "Name: Rahul Sharma"
```

Here's how we do it:

```typescript
  private static async extractPageText(page: PDFPageProxy): Promise<string> {
    // Get all text items from the page
    const textContent = await page.getTextContent();

    const lines: string[] = [];
    let currentLine = '';         // The line we're currently building
    let currentY: number | null = null;  // Y position of the current line

    for (const item of textContent.items) {
      // Skip non-text items (images, etc.)
      if (!this.isTextItem(item)) {
        continue;
      }

      // Clean up whitespace in the text
      const token = this.normalizeWhitespace(item.str);
      if (!token) {
        continue;  // Skip empty tokens
      }

      // The Y position is stored in item.transform[5]
      // pdf.js uses a 6-element transformation matrix:
      // [scaleX, skewY, skewX, scaleY, translateX, translateY]
      //                                              ^^^^^^^^^ this is Y
      const itemY = item.transform[5] ?? 0;

      // If the Y position changed by more than 4 units, it's a new line
      // Why 4? Because small floating-point differences in Y can happen
      // within the same visual line. 4 is a safe threshold.
      const isNewLine =
        currentY !== null && Math.abs(itemY - currentY) > 4;

      // If we've moved to a new line, save the current line
      if (isNewLine && currentLine) {
        lines.push(this.finalizeLine(currentLine));
        currentLine = '';
      }

      // Add a space between tokens on the same line
      // (but not after opening brackets or before closing punctuation)
      if (currentLine && this.shouldInsertSpace(currentLine, token)) {
        currentLine += ' ';
      }

      currentLine += token;
      currentY = itemY;

      // pdf.js sometimes tells us a token explicitly ends a line
      if (item.hasEOL && currentLine) {
        lines.push(this.finalizeLine(currentLine));
        currentLine = '';
        currentY = null;
      }
    }

    // Don't forget the last line
    if (currentLine) {
      lines.push(this.finalizeLine(currentLine));
    }

    return lines.join('\n').trim();
  }
```

### Step 5: Helper Methods

```typescript
  // Type guard: is this item a text item (not a marker or annotation)?
  private static isTextItem(item: unknown): item is PDFTextItem {
    return (
      typeof item === 'object' &&
      item !== null &&
      'str' in item &&
      typeof item.str === 'string' &&
      'transform' in item &&
      Array.isArray(item.transform)
    );
  }

  // Should we insert a space between the current line ending and the next token?
  private static shouldInsertSpace(currentLine: string, token: string): boolean {
    if (!currentLine) return false;

    // Don't add space after opening brackets/parens
    // e.g., "(hello" not "( hello"
    if (/[([/{-]$/.test(currentLine)) return false;

    // Don't add space before closing punctuation
    // e.g., "hello," not "hello ,"
    if (/^[,.;:!?%)\]}]/.test(token)) return false;

    return true;
  }

  // Clean up a finished line
  private static finalizeLine(line: string): string {
    // Collapse multiple spaces/tabs into one space, then trim
    return line.replace(/[ \t]+/g, ' ').trim();
  }

  // Normalize whitespace in a raw token
  private static normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  // Read a File object as an ArrayBuffer
  // (the browser's FileReader API is callback-based, so we wrap it in a Promise)
  private static readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();

      reader.onerror = () => {
        reject(reader.error ?? new Error(`Failed to read ${file.name}.`));
      };

      reader.onabort = () => {
        reject(new Error(`Reading ${file.name} was aborted.`));
      };

      reader.onload = () => {
        // Verify we got an ArrayBuffer (not a string or null)
        if (!(reader.result instanceof ArrayBuffer)) {
          reject(new Error(`Unexpected FileReader result for ${file.name}.`));
          return;
        }
        resolve(reader.result);
      };

      reader.readAsArrayBuffer(file);
    });
  }
}
```

---

## Visualizing the Extraction Flow

```
                        ┌──────────────┐
                        │   PDF File   │
                        │  (binary)    │
                        └──────┬───────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  readFileAsArrayBuffer│
                    │                      │
                    │  File → ArrayBuffer  │
                    │  (raw bytes)         │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  pdfjsLib.getDocument │
                    │                      │
                    │  Parse PDF structure │
                    │  (runs in a Worker)  │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  For each page:      │
                    │                      │
                    │  page.getTextContent()│
                    │  → Array of items    │
                    │    with str + Y pos  │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  Line Reconstruction │
                    │                      │
                    │  Group items by Y    │
                    │  position into lines │
                    │  Add spaces between  │
                    │  tokens on same line │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  PDFExtractionResult  │
                    │                      │
                    │  .fullText = all     │
                    │   pages joined       │
                    │  .pages = per-page   │
                    │  .pageCount          │
                    └──────────────────────┘
```

---

## Development Simulation: How I'd Actually Build This

### Attempt 1: "I'll just read the file as text"
```typescript
const text = await file.text();
// Result: "%PDF-1.7\n3 0 obj\n<</Type /Page..." — binary garbage!
```
**Problem:** PDFs are binary, not plain text. You can't just `.text()` them.

### Attempt 2: "I'll send it to a server for parsing"
**Problem:** That defeats the purpose! The whole point is keeping data local.

### Attempt 3: "I'll use pdf.js to extract text"
```typescript
const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
const page = await pdf.getPage(1);
const content = await page.getTextContent();
// content.items = [{str: "Employee", transform: [...]}, {str: "Report", transform: [...]}]
```
**Works!** But the items are individual words with positions, not clean lines.

### Attempt 4: "I need to reconstruct lines from scattered items"
This is the Y-position grouping algorithm. Items with the same Y position (within a threshold of 4 units) are on the same line. This is the core engineering challenge of PDF text extraction.

> **Interview Line:** "The hardest part of PDF extraction isn't reading the bytes — pdf.js handles that. The tricky part is reconstructing meaningful lines of text from individual positioned text items. I use the Y-coordinate from the transform matrix: if two items have Y positions within 4 units of each other, they're on the same visual line. I also handle edge cases like spacing around punctuation and explicit end-of-line markers."

---

## How This Connects to the Rest of the Project

```
                 ┌──────────────────────┐
                 │   PDFExtractor.ts    │  ← YOU ARE HERE
                 │                      │
                 │  Input:  File        │
                 │  Output: fullText    │
                 └──────────┬───────────┘
                            │
                            │ fullText (one big string)
                            ▼
                 ┌──────────────────────┐
                 │   Chunker.ts         │  ← NEXT PHASE
                 │                      │
                 │  Split into ~1000    │
                 │  char chunks with    │
                 │  200 char overlap    │
                 └──────────────────────┘
```

The `fullText` output from `PDFExtractor` feeds directly into the `Chunker` (Phase 3).

---

## Interview Questions

### Basic
- **Q:** "How do you extract text from a PDF in the browser?"
- **A:** "I use Mozilla's pdf.js library. It runs a Web Worker internally to parse the PDF binary format, then provides a `getTextContent()` API that returns individual text items with their positions. I reconstruct lines by grouping items with similar Y-coordinates."

### Intermediate
- **Q:** "Why is text extraction from PDFs harder than it sounds?"
- **A:** "PDFs don't store text as lines — they store individual characters or words with X/Y coordinates. The same visual line might be multiple separate items. I have to infer line breaks from Y-position changes, handle spacing rules around punctuation, and deal with explicit EOL markers."

### Advanced
- **Q:** "What's `isEvalSupported: false` in your pdf.js config?"
- **A:** "Some PDF files embed JavaScript (yes, PDFs can contain scripts). pdf.js can execute them using `eval()`. Setting `isEvalSupported: false` disables this for security — we don't want arbitrary code execution from an untrusted PDF."

### Debugging
- **Q:** "A user uploads a PDF and gets garbled text. What would you debug?"
- **A:** "First, I'd check if it's a scanned PDF (image-only, no text layer) — pdf.js can't extract text from images. Second, I'd check the encoding — some PDFs use custom fonts with non-standard character mappings. Third, I'd inspect the Y-threshold (4 units) — some PDFs with unusual layout might need a different threshold."

### Trap
- **Q:** "Why don't you use the newer `File.text()` API?"
- **A:** "`File.text()` reads the file as a UTF-8 string. PDFs are a binary format with headers, streams, and compressed objects. Reading as text would give you garbled binary data, not the actual document content. You need a PDF parser like pdf.js to interpret the binary structure."

---

**Next Phase → [03_Chunking_Text.md](./03_Chunking_Text.md)** — We'll split the extracted text into smart, overlapping chunks.
