# Phase 4: Building a Brain from Vectors (The Vector Store)

> **Goal:** We have text chunks. Now we need to find which chunks are relevant to a user's question. We do this by converting text into numbers (vectors) and finding the closest match. By the end, you should understand embeddings, cosine similarity, and be able to write `VectorStore.ts` from memory.

---

## The Core Insight: Text as Numbers

How do you find the paragraph most relevant to "What is Rahul's salary?"

### Approach 1: Keyword Search (Ctrl+F)
Search for the word "salary" in all chunks. Find chunks that contain it.

**Problem:** What if the chunk says "compensation package" instead of "salary"? Keyword search misses it because the exact word doesn't match, even though the *meaning* is identical.

### Approach 2: Semantic Search (what we use)
Convert both the question AND every chunk into arrays of numbers (called **vectors** or **embeddings**). Then find which chunk's numbers are "closest" to the question's numbers.

**Magic:** "salary" and "compensation package" produce SIMILAR number arrays because they mean similar things. The AI model learns meaning, not just words.

```
"What is Rahul's salary?"
  → [0.12, -0.45, 0.78, 0.23, -0.91, ...]   (384 numbers)

Chunk 1: "Company overview and mission statement"
  → [0.88, 0.12, -0.34, 0.56, 0.01, ...]   (384 numbers)  ← NOT similar

Chunk 2: "Rahul's annual compensation is ₹25,00,000"
  → [0.15, -0.42, 0.81, 0.19, -0.87, ...]   (384 numbers)  ← VERY similar!

Chunk 3: "Office is located in Bangalore"
  → [-0.23, 0.67, 0.11, -0.45, 0.33, ...]   (384 numbers)  ← NOT similar
```

The numbers for the question and Chunk 2 are almost identical. That's how we know Chunk 2 is relevant.

---

## What is "Cosine Similarity"?

We need a way to measure how "close" two vectors are. We use **cosine similarity**.

Think of two arrows pointing from the origin. If they point in the same direction, they're similar. If they point in opposite directions, they're dissimilar.

```
Cosine Similarity = 1.0  → Identical direction (same meaning)
Cosine Similarity = 0.0  → Perpendicular (unrelated)
Cosine Similarity = -1.0 → Opposite direction (opposite meaning)

         Similar (score ≈ 0.9)
           ↗
          /
         /
Origin ●──────────→  Query vector
         \
          \
           ↘
         Dissimilar (score ≈ 0.1)
```

### The Math (simplified)

For two vectors A and B:

```
                    A · B              (sum of element-wise products)
cosine(A, B) = ─────────────── = ─────────────────────────────────────
                |A| × |B|       (magnitude of A) × (magnitude of B)

Where:
  A · B (dot product) = A[0]*B[0] + A[1]*B[1] + ... + A[383]*B[383]
  |A| (magnitude) = sqrt(A[0]² + A[1]² + ... + A[383]²)
```

**Example with tiny 3-dimensional vectors:**

```
Query:  [1, 2, 3]
Chunk:  [2, 4, 6]    (same direction, just scaled)

Dot product = 1*2 + 2*4 + 3*6 = 2 + 8 + 18 = 28
|Query| = sqrt(1 + 4 + 9) = sqrt(14) ≈ 3.74
|Chunk| = sqrt(4 + 16 + 36) = sqrt(56) ≈ 7.48

Cosine = 28 / (3.74 × 7.48) ≈ 28 / 27.98 ≈ 1.0  ← Perfect match!
```

---

## Building `VectorStore.ts` — Step by Step

### Step 1: Define the Data Structures

```typescript
import { v4 as uuidv4 } from 'uuid';

// A stored item: text + its vector + optional metadata
export interface VectorStoreItem<TMetadata = Record<string, unknown>> {
  id: string;              // Unique identifier
  text: string;            // The original text chunk
  embedding: Float32Array; // The 384-dimensional vector
  metadata?: TMetadata;    // Extra info (chunk index, page number, etc.)
}

// What you pass in when adding an item
export interface VectorStoreInsert<TMetadata = Record<string, unknown>> {
  id?: string;                         // Optional — auto-generated if missing
  text: string;
  embedding: Float32Array | number[];  // Accept both array types
  metadata?: TMetadata;
}

// A search result: the item + its similarity score
export interface VectorSearchResult<TMetadata = Record<string, unknown>>
  extends VectorStoreItem<TMetadata> {
  score: number;  // Cosine similarity (0 to 1)
}

// Internal storage: we also cache the magnitude for performance
interface StoredVectorItem<TMetadata> extends VectorStoreItem<TMetadata> {
  magnitude: number;  // Pre-computed |v| = sqrt(v[0]² + v[1]² + ...)
}
```

> **Design Decision: Why `Float32Array` instead of `number[]`?**
> `Float32Array` is a typed array. It uses 4 bytes per number instead of JavaScript's default 8 bytes. For 384 dimensions × thousands of chunks, this halves memory usage. It also enables faster mathematical operations because the engine knows all values are 32-bit floats.

### Step 2: The Class Shell

```typescript
export class VectorStore<TMetadata = Record<string, unknown>> {
  // The actual storage — a Map from ID to stored item
  private readonly items = new Map<string, StoredVectorItem<TMetadata>>();

  // Track the embedding dimension (set by the first item added)
  private embeddingDimensions: number | null = null;
```

> **Why a Map instead of an Array?**
> - O(1) lookup by ID
> - O(1) deletion by ID
> - Easy deduplication (same ID = overwrite)
> With an array, we'd need O(n) scans for lookup/deletion.

### Step 3: Adding Items

```typescript
  add(entry: VectorStoreInsert<TMetadata>): VectorStoreItem<TMetadata> {
    // Ensure we have a Float32Array
    const embedding = this.toFloat32Array(entry.embedding);

    // Validate: embeddings must have at least one dimension
    if (embedding.length === 0) {
      throw new Error('Embeddings must contain at least one dimension.');
    }

    // Validate: all embeddings must have the SAME dimension
    // (you can't compare a 384-dim vector with a 768-dim vector)
    if (
      this.embeddingDimensions !== null &&
      embedding.length !== this.embeddingDimensions
    ) {
      throw new Error(
        `Embedding dimension mismatch. Expected ${this.embeddingDimensions}, received ${embedding.length}.`
      );
    }

    // Set the dimension from the first item (using nullish coalescing assignment)
    this.embeddingDimensions ??= embedding.length;

    // PRE-COMPUTE the magnitude
    // This is the key optimization: instead of computing sqrt(sum of squares)
    // every time we search, we compute it once when adding
    const item: StoredVectorItem<TMetadata> = {
      id: entry.id ?? uuidv4(),       // Auto-generate ID if not provided
      text: entry.text,
      embedding,
      metadata: entry.metadata,
      magnitude: this.computeMagnitude(embedding)  // ← CACHED
    };

    this.items.set(item.id, item);
    return this.toPublicItem(item);
  }

  // Convenience: add many items at once
  addMany(entries: VectorStoreInsert<TMetadata>[]): VectorStoreItem<TMetadata>[] {
    return entries.map((entry) => this.add(entry));
  }
```

### Step 4: The Search Method (The Heart)

```typescript
  search(
    queryEmbedding: Float32Array | number[],
    topK = 3  // Return the top 3 most similar items by default
  ): VectorSearchResult<TMetadata>[] {

    // Edge cases
    if (topK <= 0 || this.items.size === 0) return [];

    const normalizedQuery = this.toFloat32Array(queryEmbedding);

    // Validate query dimensions match stored dimensions
    if (
      this.embeddingDimensions !== null &&
      normalizedQuery.length !== this.embeddingDimensions
    ) {
      throw new Error(
        `Query embedding dimension mismatch. Expected ${this.embeddingDimensions}, received ${normalizedQuery.length}.`
      );
    }

    // Compute query magnitude (only once per search, not per item)
    const queryMagnitude = this.computeMagnitude(normalizedQuery);
    if (queryMagnitude === 0) return [];  // Zero vector matches nothing

    // BRUTE FORCE SEARCH: compare against every stored item
    return [...this.items.values()]
      .map((item) => ({
        ...this.toPublicItem(item),
        score: this.cosineSimilarity(
          normalizedQuery,
          queryMagnitude,       // ← computed once
          item.embedding,
          item.magnitude         // ← pre-cached from add()
        )
      }))
      .sort((left, right) => right.score - left.score)  // Highest score first
      .slice(0, topK);  // Take only the top K
  }
```

**The search algorithm visualized:**

```
Query: "What is Rahul's salary?"  →  queryVector = [0.12, -0.45, 0.78, ...]

┌─────────────────────────────────────────────────────────────┐
│  For EACH stored chunk:                                     │
│                                                             │
│  Chunk 1 vector: [0.88, 0.12, -0.34, ...]                  │
│    cosine(query, chunk1) = 0.23  ← low similarity          │
│                                                             │
│  Chunk 2 vector: [0.15, -0.42, 0.81, ...]                  │
│    cosine(query, chunk2) = 0.94  ← HIGH similarity! ✅      │
│                                                             │
│  Chunk 3 vector: [-0.23, 0.67, 0.11, ...]                  │
│    cosine(query, chunk3) = 0.11  ← low similarity          │
│                                                             │
│  ...repeat for all chunks...                                │
│                                                             │
│  Sort by score descending: [0.94, 0.67, 0.45, 0.23, 0.11]  │
│  Take top 5: [Chunk2, Chunk7, Chunk12, Chunk1, Chunk3]      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Step 5: The Math Utilities

```typescript
  // Compute the magnitude (length) of a vector
  // |v| = sqrt(v[0]² + v[1]² + ... + v[n]²)
  private computeMagnitude(vector: Float32Array): number {
    let sum = 0;
    for (const value of vector) {
      sum += value * value;
    }

    // Guard against NaN (can happen with corrupted embeddings)
    if (!Number.isFinite(sum)) {
      console.warn('Vector math resulted in NaN - check embedding validity.');
      return 0;
    }

    const magnitude = Math.sqrt(sum);
    if (!Number.isFinite(magnitude)) {
      console.warn('Vector math resulted in NaN - check embedding validity.');
      return 0;
    }

    return magnitude;
  }

  // Compute cosine similarity between two vectors
  private cosineSimilarity(
    leftVector: Float32Array,
    leftMagnitude: number,
    rightVector: Float32Array,
    rightMagnitude: number
  ): number {
    // Can't divide by zero
    if (leftMagnitude === 0 || rightMagnitude === 0) return 0;

    // Compute dot product: sum of element-wise products
    let dotProduct = 0;
    for (let index = 0; index < leftVector.length; index += 1) {
      dotProduct += leftVector[index] * rightVector[index];
    }

    if (!Number.isFinite(dotProduct)) {
      console.warn('Vector math resulted in NaN - check embedding validity.');
      return 0;
    }

    // cosine = dot(A,B) / (|A| × |B|)
    const similarity = dotProduct / (leftMagnitude * rightMagnitude);

    if (!Number.isFinite(similarity)) {
      console.warn('Vector math resulted in NaN - check embedding validity.');
      return 0;
    }

    return similarity;
  }
```

> **Performance Optimization: Pre-caching Magnitudes**
> Computing `sqrt(sum of 384 squares)` is expensive. If we have 500 chunks and search 10 times, that's 500 × 10 = 5000 magnitude calculations. By pre-computing each chunk's magnitude once during `add()`, we reduce this to 500 (one-time) + 10 (one per query) = 510 calculations. That's almost 10x fewer.

### Step 6: Utility Methods

```typescript
  // Remove all items and reset
  clear(): void {
    this.items.clear();
    this.embeddingDimensions = null;
  }

  // How many items are stored?
  size(): number {
    return this.items.size;
  }

  // Get all items (for debugging / export)
  values(): VectorStoreItem<TMetadata>[] {
    return [...this.items.values()].map((item) => this.toPublicItem(item));
  }

  // Strip internal fields (magnitude) from the public API
  private toPublicItem(item: StoredVectorItem<TMetadata>): VectorStoreItem<TMetadata> {
    return {
      id: item.id,
      text: item.text,
      embedding: new Float32Array(item.embedding),  // Return a COPY
      metadata: item.metadata
    };
  }

  // Accept both Float32Array and regular number[] as input
  private toFloat32Array(vector: Float32Array | number[]): Float32Array {
    return vector instanceof Float32Array ? vector : new Float32Array(vector);
  }
```

> **Why return a copy of the embedding in `toPublicItem`?**
> `Float32Array` is mutable. If we returned the original, external code could modify our internal data. Returning `new Float32Array(item.embedding)` creates a defensive copy. This is the **encapsulation** principle from OOP.

---

## Development Simulation

### Attempt 1: "I'll use Pinecone / Chroma / Weaviate"
**Problem:** All of these are server-side vector databases. They need a backend. Our app runs entirely in the browser.

### Attempt 2: "I'll use `similarity-search` npm package"
**Problem:** Most packages are Node.js only and don't work in the browser. Also, adding a dependency for 50 lines of math is overkill.

### Attempt 3: "I'll write my own in-memory vector store"
**This is the final solution.** It's ~190 lines of TypeScript. It uses a `Map` for O(1) storage and brute-force cosine similarity for search.

### "But brute-force is O(n)! Won't it be slow?"
For our use case, no. A typical PDF has 50-200 chunks. Computing cosine similarity over 200 chunks with 384-dimensional vectors takes ~1 millisecond. We'd need 100,000+ chunks before performance becomes an issue.

For scale, real vector databases use approximate nearest neighbor (ANN) algorithms like HNSW or IVF. But for our use case, brute-force is simpler and fast enough.

> **Interview Line:** "I considered using Pinecone or Chroma, but they're server-side services. Since the entire app runs in the browser, I wrote a lightweight in-memory vector store. It uses a HashMap for storage and brute-force cosine similarity for search. With typical document sizes (50-200 chunks), the search completes in under 1ms. For larger scales, I'd implement ANN indexing like HNSW."

---

## How This Connects to the Pipeline

```
 Chunker.ts              embedding-worker.ts         VectorStore.ts
┌────────────────┐     ┌────────────────────┐     ┌──────────────────┐
│                │     │                    │     │                  │
│  TextChunk[]   │     │  For each chunk:   │     │  Store:          │
│  [{text: "..."}, ──▶ │  text → vector     │ ──▶ │  text + vector   │
│   {text: "..."},│     │  (384 dimensions)  │     │                  │
│   ...]          │     │                    │     │  Search:         │
│                │     │  Uses MiniLM-L6    │     │  query vector →  │
│                │     │  AI model          │     │  Top-K matches   │
└────────────────┘     └────────────────────┘     └──────────────────┘
```

In `useDocumentAI.ts`:
```typescript
const chunks = chunker.split(extracted.fullText);
const embeddings = await embedTexts(chunks.map(c => c.text));  // Worker call

// Build insert records
const records = chunks.map((chunk, index) => ({
  text: chunk.text,
  embedding: embeddings[index],
  metadata: { chunkIndex: chunk.index, length: chunk.length }
}));

vectorStoreRef.current.addMany(records);  // ← VectorStore.add()

// Later, during query:
const matches = vectorStoreRef.current.search(queryEmbedding, topK);
```

---

## Interview Questions

### Basic
- **Q:** "What is an embedding?"
- **A:** "A fixed-size array of floating-point numbers that represents the *meaning* of text. Similar meanings produce similar number arrays. I use the MiniLM-L6 model which produces 384-dimensional embeddings."

### Intermediate
- **Q:** "Why cosine similarity instead of Euclidean distance?"
- **A:** "Cosine similarity measures the *angle* between vectors, not the *distance*. This means it's robust to magnitude differences. Two vectors with the same direction but different lengths (e.g., a short sentence and a long paragraph about the same topic) still get a high similarity score. Euclidean distance would penalize the length difference."

### Advanced
- **Q:** "What's the time complexity of your search?"
- **A:** "O(n × d) per query, where n is the number of chunks and d is the embedding dimension (384). The sort is O(n log n) but dominated by the dot product computation. I pre-cache magnitudes during insertion, reducing the per-query cost from O(n × d) for magnitude computation to O(1) per item."

### Trap
- **Q:** "You're doing brute-force search. Isn't that inefficient?"
- **A:** "For our scale, no. A typical PDF produces 50-200 chunks. The search completes in under 1ms. Brute-force is actually *optimal* for small datasets because ANN indexes (like HNSW) have high construction cost and memory overhead that only pays off at 10,000+ vectors. For production at scale, I'd switch to an ANN index, but for browser-based single-document use, brute-force is the right choice."

### Design
- **Q:** "How would you scale this to handle millions of vectors?"
- **A:** "First, I'd move from in-memory to a proper vector database like Pinecone, Milvus, or pgvector. Second, I'd use an approximate nearest neighbor algorithm — HNSW (Hierarchical Navigable Small World) gives O(log n) search with 95%+ recall. Third, I'd batch embeddings and use dimensionality reduction (e.g., PCA from 384 to 128 dims) to reduce memory."

---

**Next Phase → [05_Web_Workers.md](./05_Web_Workers.md)** — We'll build the AI workers that run ML models in background threads.
