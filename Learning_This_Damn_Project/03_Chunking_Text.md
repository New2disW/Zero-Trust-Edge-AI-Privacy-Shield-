# Phase 3: Chopping Text into Smart Pieces (Chunking)

> **Goal:** We now have the full text of a PDF. But it could be 50,000 characters long. An AI model can't process all of that at once, and vector search works better on smaller pieces. We need to split the text into smart, overlapping chunks. By the end, you should be able to write `Chunker.ts` from memory.

---

## Why Can't We Just Send the Whole Text?

Three problems:

### Problem 1: AI models have token limits
LLMs like Llama 3 have a maximum context window (e.g., 8192 tokens). A 100-page PDF has ~150,000 tokens. It simply won't fit.

### Problem 2: Vector search needs small pieces
When the user asks "What is Rahul's salary?", we want to find the **specific paragraph** that mentions Rahul's salary — not the entire document. Smaller chunks = more precise search results.

### Problem 3: Relevance dilution
If you feed the AI 50,000 characters but only 200 characters are relevant, the AI's answer quality drops. Smaller chunks mean less noise.

```
❌ BAD: One huge chunk (entire document)
┌────────────────────────────────────────────────────┐
│ Chapter 1: Introduction...                         │
│ Chapter 2: Background...                           │
│ ...                                                │
│ Page 47: Rahul Sharma earns ₹25,00,000            │  ← buried!
│ ...                                                │
│ Chapter 20: Conclusion...                          │
└────────────────────────────────────────────────────┘

✅ GOOD: Small, focused chunks
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│ Chunk 1:         │ │ Chunk 2:         │ │ Chunk 47:        │
│ Chapter 1...     │ │ More intro...    │ │ Rahul Sharma     │
│ Introduction...  │ │                  │ │ earns ₹25,00,000 │ ← easy to find!
└──────────────────┘ └──────────────────┘ └──────────────────┘
```

---

## The Overlap Problem

Naive splitting has a critical flaw:

```
Original text: "Rahul Sharma works in Finance. His annual salary is ₹25,00,000."
                                              ↑
                                     If we split RIGHT HERE...

Chunk 1: "Rahul Sharma works in Finance. His an"
Chunk 2: "nual salary is ₹25,00,000."

Neither chunk has the complete sentence!
If the user asks "What is Rahul's salary?", the vector search might find
Chunk 2 (it mentions "salary") but it doesn't mention "Rahul".
Chunk 1 mentions "Rahul" but not "salary".

We lose the connection between the person and the information.
```

**Solution: Overlapping chunks**

```
Chunk 1: "Rahul Sharma works in Finance. His annual salary is ₹25,00"
Chunk 2:                       "Finance. His annual salary is ₹25,00,000."
                               ←──────── OVERLAP ─────────→

Now both chunks contain "salary" AND are close to "Rahul".
The overlap region ensures no information is lost at chunk boundaries.
```

---

## The Recursive Splitting Strategy

We don't just split at every 1000th character. That would break words and sentences.

Instead, we use a **hierarchy of separators** — split at the most meaningful boundary first:

```
Priority 1: Split at paragraph boundaries ("\n\n")     ← best: preserves full paragraphs
Priority 2: Split at line boundaries ("\n")             ← good: preserves full lines
Priority 3: Split at sentence boundaries (". ")         ← okay: preserves full sentences
Priority 4: Split at word boundaries (" ")              ← acceptable: preserves full words
Priority 5: Split at character boundaries ("")           ← last resort: hard cut
```

The algorithm is **recursive**: if splitting at `\n\n` produces pieces that are still too large, we split those pieces at `\n`, and so on.

```
"Chapter 1\n\nLong paragraph that is 3000 chars...\n\nChapter 2\n\n..."
                                                    │
Step 1: Split at "\n\n" ────────────────────────────┘
├── "Chapter 1"  (short, fits in one chunk ✅)
├── "Long paragraph that is 3000 chars..."  (too long! ❌)
│   │
│   Step 2: Split at "\n" ──────────┘
│   ├── "First line..."  (fits ✅)
│   ├── "Still too long line..."  (too long! ❌)
│   │   │
│   │   Step 3: Split at ". " ──────┘
│   │   ├── "First sentence."  (fits ✅)
│   │   └── "Second sentence."  (fits ✅)
│   └── "Last line"  (fits ✅)
└── "Chapter 2"  (fits ✅)
```

---

## Building `Chunker.ts` — Step by Step

### Step 1: Define the Data Structures

```typescript
// Configuration options for the chunker
export interface ChunkerOptions {
  chunkSize?: number;      // Max characters per chunk (default: 1000)
  chunkOverlap?: number;   // Characters of overlap between chunks (default: 200)
  separators?: string[];   // Priority list of split points
}

// What a chunk looks like
export interface TextChunk {
  index: number;   // Position in the array (0, 1, 2, ...)
  text: string;    // The actual text content
  length: number;  // Character count
}

// The default separator hierarchy
const DEFAULT_SEPARATORS = ['\n\n', '\n', '. ', ' ', ''];
```

### Step 2: The Constructor

```typescript
export class Chunker {
  private readonly chunkSize: number;
  private readonly chunkOverlap: number;
  private readonly separators: string[];

  constructor(options: ChunkerOptions = {}) {
    // Use defaults if not provided
    this.chunkSize = options.chunkSize ?? 1000;
    this.chunkOverlap = options.chunkOverlap ?? 200;
    this.separators = options.separators ?? DEFAULT_SEPARATORS;

    // VALIDATION — catch bad configs early
    if (this.chunkSize <= 0) {
      throw new Error('chunkSize must be greater than 0.');
    }
    if (this.chunkOverlap < 0) {
      throw new Error('chunkOverlap must be 0 or greater.');
    }
    if (this.chunkOverlap >= this.chunkSize) {
      // If overlap >= size, chunks would never advance forward!
      // You'd get infinite chunks of the same text.
      throw new Error('chunkOverlap must be smaller than chunkSize.');
    }
  }
```

> **Why validate in the constructor?**
> Fail fast. If someone creates a `Chunker({ chunkOverlap: 2000, chunkSize: 1000 })`, it's better to throw immediately than to silently produce an infinite loop later.

### Step 3: The Public `split()` Method

```typescript
  split(text: string): TextChunk[] {
    const normalized = text.trim();
    if (!normalized) {
      return [];  // Empty text → no chunks
    }

    // Phase 1: Recursively split into atomic pieces
    // (each piece is ≤ chunkSize characters)
    const atomicSplits = this.splitRecursively(normalized, this.separators);

    // Phase 2: Merge small pieces back together with overlap
    const mergedChunks = this.mergeSplits(atomicSplits);

    // Phase 3: Wrap in TextChunk objects with index and length
    return mergedChunks.map((chunk, index) => ({
      index,
      text: chunk,
      length: chunk.length
    }));
  }
```

The algorithm has **two phases**: split, then merge. This is a critical design choice:

```
Phase 1 (Split):  "A very long text" → ["A", "very", "long", "text"]
                   Break into tiny atomic pieces

Phase 2 (Merge):  ["A", "very", "long", "text"] → ["A very long", "long text"]
                   Combine pieces back up to chunkSize, with overlap
```

### Step 4: Recursive Splitting (Phase 1)

```typescript
  private splitRecursively(text: string, separators: string[]): string[] {
    const normalized = text.trim();
    if (!normalized) return [];

    // BASE CASE: text already fits in one chunk
    if (normalized.length <= this.chunkSize) {
      return [normalized];
    }

    // Find the best separator to use
    // (the first one in our priority list that actually appears in the text)
    const separator = this.selectSeparator(normalized, separators);

    // If no separator works, we have to hard-split by character
    if (separator === '') {
      return this.splitByLength(normalized);
    }

    // Get the remaining separators (for recursive calls)
    const nextSeparators = separators.slice(separators.indexOf(separator) + 1);

    // Split the text at this separator
    const rawSplits = this.splitWithSeparator(normalized, separator);

    const results: string[] = [];
    for (const split of rawSplits) {
      const segment = split.trim();
      if (!segment) continue;

      if (segment.length <= this.chunkSize) {
        // Small enough — keep it
        results.push(segment);
      } else {
        // Still too big — recurse with finer separators
        results.push(
          ...this.splitRecursively(
            segment,
            nextSeparators.length ? nextSeparators : ['']
          )
        );
      }
    }

    return results;
  }
```

**Visualizing the recursion:**

```
Input: "Paragraph A.\n\nVery long paragraph B that is 3000 chars.\n\nParagraph C."

splitRecursively(text, ['\n\n', '\n', '. ', ' ', ''])
│
├── separator = '\n\n'  (found in text ✅)
│
├── Split produces:
│   ├── "Paragraph A."          → length 12 ≤ 1000 → KEEP ✅
│   ├── "Very long paragraph B" → length 3000 > 1000 → RECURSE ↓
│   │   │
│   │   splitRecursively(text, ['\n', '. ', ' ', ''])
│   │   ├── separator = '. '   (found ✅)
│   │   ├── Split produces:
│   │   │   ├── "First sentence."  → KEEP ✅
│   │   │   ├── "Second sentence." → KEEP ✅
│   │   │   └── "Third sentence."  → KEEP ✅
│   │
│   └── "Paragraph C."          → length 13 ≤ 1000 → KEEP ✅
│
└── Final atomic pieces: ["Paragraph A.", "First sentence.", "Second sentence.", "Third sentence.", "Paragraph C."]
```

### Step 5: Separator Selection and Splitting

```typescript
  // Find the first separator that exists in the text
  private selectSeparator(text: string, separators: string[]): string {
    for (const separator of separators) {
      if (separator === '' || text.includes(separator)) {
        return separator;
      }
    }
    return '';  // No separator found — will hard-split
  }

  // Split text at a separator, keeping the separator attached to the preceding segment
  private splitWithSeparator(text: string, separator: string): string[] {
    if (separator === '') {
      return text.split('');  // Character-level split
    }

    const results: string[] = [];
    let startIndex = 0;

    while (startIndex < text.length) {
      // Find the next occurrence of the separator
      const separatorIndex = text.indexOf(separator, startIndex);

      if (separatorIndex === -1) {
        // No more separators — take the rest
        results.push(text.slice(startIndex));
        break;
      }

      // Include the separator in this segment
      // Why? So we don't lose the separator text.
      // "\n\n" between paragraphs is meaningful.
      const endIndex = separatorIndex + separator.length;
      results.push(text.slice(startIndex, endIndex));
      startIndex = endIndex;
    }

    return results;
  }
```

### Step 6: Merging Splits with Overlap (Phase 2)

This is the **most important** part of the chunker. We take the tiny atomic pieces and combine them back into chunks of the target size, WITH overlap.

```typescript
  private mergeSplits(splits: string[]): string[] {
    const chunks: string[] = [];
    let currentSegments: string[] = [];  // Segments in the current chunk
    let currentLength = 0;                // Total length of current chunk

    for (const split of splits) {
      // If a single split is larger than chunkSize, hard-split it
      if (split.length > this.chunkSize) {
        // Save what we have so far
        if (currentSegments.length) {
          chunks.push(this.normalizeChunk(currentSegments.join('')));
          currentSegments = [];
          currentLength = 0;
        }
        // Hard-split the oversized piece
        chunks.push(...this.splitByLength(split));
        continue;
      }

      // Would adding this split exceed the chunk size?
      if (currentSegments.length > 0 && currentLength + split.length > this.chunkSize) {
        // Save the current chunk
        chunks.push(this.normalizeChunk(currentSegments.join('')));

        // KEY STEP: Keep some trailing segments for OVERLAP
        ({ currentSegments, currentLength } = this.trimToOverlap(currentSegments));
      }

      // Add the split to the current chunk
      currentSegments.push(split);
      currentLength += split.length;
    }

    // Don't forget the last chunk
    if (currentSegments.length > 0) {
      chunks.push(this.normalizeChunk(currentSegments.join('')));
    }

    // Remove empty chunks and exact duplicates
    return chunks.filter(
      (chunk, index) => chunk.length > 0 && chunk !== chunks[index - 1]
    );
  }
```

### Step 7: The Overlap Mechanism

```typescript
  // After emitting a chunk, keep some trailing segments for overlap
  private trimToOverlap(segments: string[]): {
    currentSegments: string[];
    currentLength: number;
  } {
    const overlapSegments = [...segments];
    let overlapLength = overlapSegments.reduce(
      (total, segment) => total + segment.length, 0
    );

    // Remove segments from the FRONT until we're within the overlap budget
    while (overlapSegments.length > 0 && overlapLength > this.chunkOverlap) {
      const removed = overlapSegments.shift();
      overlapLength -= removed?.length ?? 0;
    }

    return {
      currentSegments: overlapSegments,
      currentLength: overlapLength
    };
  }
```

**Visualizing the overlap:**

```
chunkSize = 20, chunkOverlap = 8

Segments: ["Hello ", "World ", "this ", "is ", "a ", "test ", "of ", "chunking"]

Building Chunk 1:
  Add "Hello " (6)  → currentLength = 6
  Add "World " (6)  → currentLength = 12
  Add "this " (5)   → currentLength = 17
  Add "is " (3)     → 17 + 3 = 20 > 20 → EMIT CHUNK 1!

  Chunk 1 = "Hello World this "

  trimToOverlap(["Hello ", "World ", "this "]):
    Total = 17, need ≤ 8
    Remove "Hello " → 11, still > 8
    Remove "World " → 5, now ≤ 8 ✅
    Keep: ["this "], length = 5

Building Chunk 2 (starts with overlap):
  currentSegments = ["this "] (from overlap)
  Add "is " (3)    → currentLength = 8
  Add "a " (2)     → currentLength = 10
  Add "test " (5)  → currentLength = 15
  Add "of " (3)    → 15 + 3 = 18
  Add "chunking" (8) → 18 + 8 = 26 > 20 → EMIT CHUNK 2!

  Chunk 2 = "this is a test of "
            ←─────→
            OVERLAP with Chunk 1!
```

### Step 8: Hard Split by Length (Last Resort)

```typescript
  private splitByLength(text: string): string[] {
    const chunks: string[] = [];
    let startIndex = 0;

    while (startIndex < text.length) {
      const endIndex = Math.min(startIndex + this.chunkSize, text.length);
      const slice = this.normalizeChunk(text.slice(startIndex, endIndex));

      if (slice) {
        chunks.push(slice);
      }

      if (endIndex === text.length) break;

      // Move forward by (chunkSize - overlap) to maintain overlap
      startIndex = Math.max(endIndex - this.chunkOverlap, startIndex + 1);
    }

    return chunks;
  }

  // Clean up whitespace in a finished chunk
  private normalizeChunk(chunk: string): string {
    return chunk
      .replace(/[ \t]+\n/g, '\n')      // Remove trailing spaces before newlines
      .replace(/\n{3,}/g, '\n\n')       // Collapse 3+ newlines into 2
      .replace(/[ \t]{2,}/g, ' ')       // Collapse multiple spaces into one
      .trim();
  }
```

---

## Development Simulation

### Attempt 1: "I'll just split every 1000 characters"
```typescript
const chunks = [];
for (let i = 0; i < text.length; i += 1000) {
  chunks.push(text.slice(i, i + 1000));
}
```
**Problem:** Breaks in the middle of words, sentences, and even entities. "Rahul Sha" | "rma earns ₹25..." — terrible for both search and AI comprehension.

### Attempt 2: "I'll split at sentence boundaries"
```typescript
const chunks = text.split('. ');
```
**Problem:** Some sentences are 5 characters ("OK.") and some are 5000 characters (a legal clause). Uneven chunks give poor search results. Also, no overlap.

### Attempt 3: "I'll use the recursive approach"
Split at the best separator, recurse for oversized pieces, then merge with overlap.
**This is the final solution.** It produces consistent-sized chunks that respect natural text boundaries.

> **Interview Line:** "I considered simple character splitting but it breaks mid-word. I also considered sentence splitting but that gives wildly uneven chunks. The recursive approach tries paragraph boundaries first, falls back to lines, then sentences, then words. After splitting into atomic pieces, I merge them back with a configurable overlap window to prevent information loss at chunk boundaries."

---

## How This Connects to the Pipeline

```
 PDFExtractor.ts              Chunker.ts                   VectorStore
┌─────────────────┐     ┌─────────────────────┐     ┌──────────────────┐
│                 │     │                     │     │                  │
│  fullText       │────▶│  split(fullText)    │────▶│  Store chunks +  │
│  (one big       │     │                     │     │  their vectors   │
│   string)       │     │  → TextChunk[]      │     │                  │
│                 │     │    [{text, index},   │     │                  │
│                 │     │     {text, index},   │     │                  │
│                 │     │     ...]             │     │                  │
└─────────────────┘     └─────────────────────┘     └──────────────────┘
```

In `useDocumentAI.ts`, this connection looks like:
```typescript
const extracted = await PDFExtractor.extract(file);     // Phase 2
const chunks = chunker.split(extracted.fullText);        // Phase 3 ← HERE
const embeddings = await embedTexts(chunks.map(c => c.text)); // Phase 4 (next)
```

---

## Interview Questions

### Basic
- **Q:** "Why do you split the document into chunks?"
- **A:** "Three reasons: LLMs have token limits and can't process entire documents; vector search is more precise on smaller pieces; and smaller context means less noise in the AI's answer."

### Intermediate
- **Q:** "Why use overlapping chunks? What's the tradeoff?"
- **A:** "Overlap prevents information loss at chunk boundaries. If a sentence like 'Rahul earns ₹25L' falls right at a boundary, overlap ensures both adjacent chunks contain the full sentence. The tradeoff is ~20% more chunks (200/1000 = 20%), which means ~20% more embeddings to compute and store. But the retrieval quality improvement is worth it."

### Advanced
- **Q:** "Explain the recursive splitting algorithm."
- **A:** "I use a separator hierarchy: paragraph breaks, then lines, then sentences, then words, then characters. The algorithm first tries splitting at the highest-priority separator. If any resulting piece is still larger than `chunkSize`, it recurses with the next separator. This is divide-and-conquer: first split coarsely, then refine. After recursion produces atomic pieces, a merge pass combines them back to target size with overlap."

### Trap
- **Q:** "Why not use LangChain's `RecursiveCharacterTextSplitter`?"
- **A:** "I considered it, but LangChain adds ~2MB of dependencies for one utility function. My implementation is 215 lines of TypeScript with zero external dependencies. For a browser-based app where bundle size matters, hand-writing it made more sense. The algorithm is identical in principle — recursive separator-based splitting with overlap."

---

**Next Phase → [04_Vector_Store.md](./04_Vector_Store.md)** — We'll build the in-memory vector database for semantic search.
