# Phase 6: The Privacy Engine — PII Detection and Masking

> **Goal:** This is the heart of the project — the reason it exists. We detect sensitive information (names, IDs, emails, phone numbers) in document chunks and replace them with safe placeholders BEFORE sending anything to the cloud AI. By the end, you'll understand regex-based PII detection, the global token ledger, and the dual-layer sanitization architecture.

---

## Where Does Sanitization Live?

There are actually **two sanitization systems** in the codebase:

1. **`sanitizeChunksJIT.ts`** — The original standalone sanitization engine (DEAD CODE — never imported)
2. **The sanitization logic inside `useDocumentAI.ts`** — The actual system used in production

Both implement the same concept but in different ways. The production system integrates directly with the NER worker and has a more sophisticated global ledger. We'll study both, starting with the concepts from the original `sanitizeChunksJIT.ts` (it's cleaner to read) and then seeing how the production code in `useDocumentAI.ts` works.

---

## The Three Layers of PII Detection

```
┌──────────────────────────────────────────────────────────────┐
│                    TEXT INPUT                                  │
│  "Rahul Sharma's PAN is ABCDE1234F and email is              │
│   rahul@company.com. He works at Tekion Corp in Bangalore."  │
└────────────────────────┬─────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│  LAYER 1: DETERMINISTIC REGEX                                 │
│                                                               │
│  Structured patterns with KNOWN formats:                      │
│  • PAN: ABCDE1234F → [PAN_1]                                │
│  • Email: rahul@company.com → [EMAIL_1]                      │
│  • Aadhaar, GSTIN, IFSC, Phone, UPI, SSN, etc.              │
│                                                               │
│  Result: "[PERSON???] [PAN_1] and email is [EMAIL_1].        │
│          He works at Tekion Corp in Bangalore."               │
│                                                               │
│  ✅ Catches: Structured IDs with fixed patterns               │
│  ❌ Misses:  Names, organizations (no fixed pattern)          │
└────────────────────────┬─────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│  LAYER 2: NER (Named Entity Recognition) AI MODEL             │
│                                                               │
│  BERT-based AI that understands CONTEXT:                      │
│  • "Rahul Sharma" → PERSON                                   │
│  • "Tekion Corp" → ORGANIZATION                              │
│  • "Bangalore" → LOCATION                                    │
│                                                               │
│  Result: "[PERSON_1]'s [PAN_1] and email is [EMAIL_1].       │
│          He works at [ORG_1] in [LOCATION_1]."               │
│                                                               │
│  ✅ Catches: Names, organizations, locations                  │
│  ❌ Cannot:  Detect structured IDs (not trained for regex)    │
└────────────────────────┬─────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│  LAYER 3: CROSS-CHUNK GLOBAL TOKEN LEDGER                     │
│                                                               │
│  Same entity across different chunks → same placeholder       │
│                                                               │
│  Chunk 1: "Rahul Sharma earns ₹25L"  → "[PERSON_1] earns.." │
│  Chunk 5: "Mr. Sharma is in Finance" → "[PERSON_1] is in.." │
│  Chunk 9: "Contact: Rahul"           → "[PERSON_1]"         │
│                                                               │
│  All refer to the same person → all become [PERSON_1]        │
└──────────────────────────────────────────────────────────────┘
```

---

## Layer 1: The Regex Rules (20+ Entity Types)

Each regex rule is a **Strategy object** with a `regex` pattern and a `tag` label:

```typescript
// From useDocumentAI.ts — the actual regex rules used in production
const REGEX_PII_RULES: PIIDefense[] = [
  // INDIAN GOVERNMENT IDs
  {
    tag: 'AADHAAR',
    // 12 digits, optionally separated by spaces or hyphens in groups of 4
    // e.g., "4567 8912 1003" or "456789121003"
    regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g
  },
  {
    tag: 'PAN',
    // Indian PAN: 5 uppercase letters + 4 digits + 1 uppercase letter
    // e.g., "ABCDE1234F"
    regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g
  },
  {
    tag: 'GSTIN',
    // GST Identification Number: state code + PAN + entity number + checksum
    // e.g., "27ABCDE1234F1ZP"
    regex: /\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d][A-Z]\b/g
  },
  {
    tag: 'IFSC',
    // Bank IFSC: 4 letters + 0 + 6 alphanumeric characters
    // e.g., "SBIN0001234"
    regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g
  },
  {
    tag: 'INDIAN_PHONE',
    // Indian phone: optional +91 prefix, then 10 digits starting with 6-9
    regex: /(?:\+91[\s-]?)?(?:0)?[6-9]\d{9}\b/g
  },
  {
    tag: 'UPI',
    // UPI ID: something@bank
    // e.g., "rahul@oksbi" or "user123@paytm"
    regex: /\b[\w.+-]+@[a-z]{2,}\b/gi
  },

  // GLOBAL PATTERNS
  {
    tag: 'EMAIL',
    // Standard email pattern
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
  },
  {
    tag: 'SSN',
    // US Social Security Number: XXX-XX-XXXX
    regex: /\b\d{3}-\d{2}-\d{4}\b/g
  },
  {
    tag: 'CREDIT_CARD',
    // Credit card: 4 groups of 4 digits
    regex: /\b(?:\d{4}[\s-]?){3}\d{4}\b/g
  },
  {
    tag: 'IP_ADDRESS',
    // IPv4 address
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
  },
  {
    tag: 'DATE_OF_BIRTH',
    // Various date formats: DD/MM/YYYY, DD-MM-YYYY, etc.
    regex: /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g
  },
  {
    tag: 'PASSPORT',
    // Passport number: 1 letter + 7 digits
    regex: /\b[A-Z]\d{7}\b/g
  }
];
```

### Why Order Matters (Substring Collision Prevention)

```
Problem: UPI regex  /[\w.+-]+@[a-z]+/  can match emails too!
"rahul@company.com" matches BOTH UPI and EMAIL patterns.

Solution: Process more specific patterns FIRST.
EMAIL (more specific, requires .TLD) runs before UPI.
Once an email is masked, UPI can't match it.
```

In the original `sanitizeChunksJIT.ts`, there's a `priority` field:
```typescript
const REGEX_PII_RULES = [
  { tag: 'EMAIL', regex: /.../, priority: 1 },    // Runs first (most specific)
  { tag: 'UPI',   regex: /.../, priority: 5 },    // Runs later (less specific)
  // ...
];
// Sorted by priority: lower number = runs first
```

---

## Layer 3: The Global Token Ledger

The ledger is a `Map` that ensures the same real-world entity always maps to the same placeholder, even across different chunks.

```typescript
// The ledger data structure
interface TokenRegistry {
  nextCounterByLabel: Map<string, number>;  // PERSON → 3 (next person will be PERSON_4)
  tokenByFingerprint: Map<string, string>;  // "PERSON::rahul sharma" → "[PERSON_1]"
}

function getOrCreateSessionToken(
  label: string,        // e.g., "PERSON"
  originalValue: string, // e.g., "Rahul Sharma"
  registry: TokenRegistry
): string {
  // Create a fingerprint: normalize to lowercase for case-insensitive matching
  const fingerprint = `${label}::${originalValue.toLowerCase().trim()}`;

  // Check if we've seen this entity before
  const existing = registry.tokenByFingerprint.get(fingerprint);
  if (existing) {
    return existing;  // Reuse the same placeholder!
  }

  // First time seeing this entity — mint a new token
  const counter = registry.nextCounterByLabel.get(label) ?? 1;
  const token = `[${label}_${counter}]`;

  // Update the registry
  registry.nextCounterByLabel.set(label, counter + 1);
  registry.tokenByFingerprint.set(fingerprint, token);

  return token;
}
```

**Visualizing the ledger in action:**

```
Chunk 1: "Rahul Sharma earns ₹25,00,000"
  → getOrCreateSessionToken("PERSON", "Rahul Sharma")
  → fingerprint = "PERSON::rahul sharma"
  → Not in map → Create [PERSON_1]
  → Result: "[PERSON_1] earns ₹25,00,000"

Chunk 5: "Mr. Sharma is in the Finance department"
  → getOrCreateSessionToken("PERSON", "Sharma")
  → fingerprint = "PERSON::sharma"
  → Not in map → Create [PERSON_2]
  → Result: "Mr. [PERSON_2] is in the Finance department"

  ⚠️ Wait — "Sharma" and "Rahul Sharma" get different tokens!
  This is a limitation. Perfect co-reference resolution is very hard.
  For production, you'd need a co-reference resolution model.

Chunk 9: "rahul sharma can be reached at..."
  → getOrCreateSessionToken("PERSON", "rahul sharma")
  → fingerprint = "PERSON::rahul sharma"
  → FOUND in map → Return [PERSON_1]  ✅
  → Result: "[PERSON_1] can be reached at..."
```

> **Key insight:** The ledger uses **case-insensitive fingerprinting**. "Rahul Sharma", "RAHUL SHARMA", and "rahul sharma" all map to the same token. But "Sharma" alone is treated as a different entity because exact substring matching is the safest approach without a full NLP co-reference system.

---

## The Dual-Layer Input/Output Sanitization

The production code in `useDocumentAI.ts` has TWO separate sanitization passes:

### Pass 1: Sanitize the User's Input Query

Before the user's question is sent to the LLM:

```typescript
// In useDocumentAI.ts (simplified)
const sanitizeUserInput = async (rawQuery: string): Promise<{
  sanitizedText: string;
  dictionary: Record<string, { label: string; original: string }>;
}> => {
  let text = rawQuery;
  const dictionary: Record<string, { label: string; original: string }> = {};

  // Step 1: Regex scan for structured PII in the user's query
  for (const rule of REGEX_PII_RULES) {
    const matches = text.matchAll(rule.regex);
    for (const match of matches) {
      const token = getOrCreateSessionToken(rule.tag, match[0], tokenRegistry);
      dictionary[token] = { label: rule.tag, original: match[0] };
      text = text.replace(match[0], token);
    }
  }

  // Step 2: NER scan for names/orgs/locations
  const nerResult = await runNER([text]);
  // ... apply NER-detected entities the same way

  return { sanitizedText: text, dictionary };
};
```

### Pass 2: Sanitize the Retrieved Document Chunks

Before the Top-K chunks are sent to the LLM:

```typescript
const sanitizeDocumentChunks = async (
  chunks: VectorSearchResult[],
  sharedRegistry: TokenRegistry  // ← SAME registry as Pass 1!
): Promise<RedactedSearchResult[]> => {
  const results: RedactedSearchResult[] = [];

  for (const chunk of chunks) {
    let text = chunk.text;
    const dictionary: Record<string, { label: string; original: string }> = {};

    // Step 1: Regex PII rules
    for (const rule of REGEX_PII_RULES) {
      // ... same as above
    }

    // Step 2: NER detection
    // ... same as above

    results.push({
      ...chunk,
      redactedText: text,
      dictionary
    });
  }

  return results;
};
```

> **Critical detail:** Both passes share the **SAME `tokenRegistry`**. This means if the user types "Rahul" in their query and "Rahul Sharma" appears in a chunk, they both map to related tokens from the same ledger.

```
┌────────────────────────────────────────────────────┐
│                SHARED TOKEN REGISTRY                │
│                                                    │
│  tokenByFingerprint:                               │
│  ├── "PERSON::rahul" → "[PERSON_1]"   (from query)│
│  ├── "PERSON::rahul sharma" → "[PERSON_2]" (chunk) │
│  ├── "EMAIL::rahul@co.com" → "[EMAIL_1]"  (chunk)  │
│  └── "PAN::abcde1234f" → "[PAN_1]"       (chunk)  │
│                                                    │
│  This registry is shared between:                   │
│  • sanitizeUserInput()                             │
│  • sanitizeDocumentChunks()                        │
│                                                    │
│  So the LLM sees a consistent set of tokens        │
│  across both the query and the context chunks.      │
└────────────────────────────────────────────────────┘
```

---

## The `sanitizeChunksJIT.ts` File (Original Implementation)

Even though this file is dead code, it contains the clearest implementation of the concepts. Let's study its architecture:

```typescript
// The original standalone function
export async function sanitizeChunksJIT(
  chunks: Array<{ text: string; metadata?: any }>,
  nerWorkerFn: (texts: string[]) => Promise<RedactionResult[]>,
  existingRegistry?: TokenRegistry
): Promise<{
  sanitizedChunks: Array<{ redactedText: string; dictionary: Record<string, any> }>;
  globalRegistry: TokenRegistry;
}> {
  const registry = existingRegistry ?? createEmptyRegistry();
  const sanitizedChunks = [];

  for (const chunk of chunks) {
    // STEP 1: Apply regex rules (right-to-left for offset stability)
    const { text: regexCleaned, matches } = applyRegexRules(chunk.text, registry);

    // STEP 2: Apply NER model
    const nerResults = await nerWorkerFn([regexCleaned]);

    // STEP 3: Apply NER results with offset-safe replacement
    const { text: fullyCleaned, nerMatches } = applyNERResults(regexCleaned, nerResults[0], registry);

    // Build dictionary for this chunk
    const dictionary = buildDictionary([...matches, ...nerMatches]);

    sanitizedChunks.push({ redactedText: fullyCleaned, dictionary });
  }

  return { sanitizedChunks, globalRegistry: registry };
}
```

### The Right-to-Left Replacement Implementation

```typescript
function applyRegexRules(text: string, registry: TokenRegistry) {
  // Collect ALL matches from ALL rules first
  const allMatches: Array<{ start: number; end: number; tag: string; value: string }> = [];

  for (const rule of REGEX_PII_RULES) {
    let match;
    while ((match = rule.regex.exec(text)) !== null) {
      allMatches.push({
        start: match.index,
        end: match.index + match[0].length,
        tag: rule.tag,
        value: match[0]
      });
    }
  }

  // Sort RIGHT-TO-LEFT (highest start position first)
  allMatches.sort((a, b) => b.start - a.start);

  // Replace from right to left
  let result = text;
  for (const match of allMatches) {
    const token = getOrCreateSessionToken(match.tag, match.value, registry);
    result = result.slice(0, match.start) + token + result.slice(match.end);
  }

  return { text: result, matches: allMatches };
}
```

---

## Development Simulation

### Attempt 1: "I'll just use regex for everything"
**Problem:** Regex can't detect person names. "Rahul Sharma" has no fixed format. You'd need a regex for every possible name in the world — impossible.

### Attempt 2: "I'll just use the NER model for everything"
**Problem:** NER models are trained on names/orgs/locations. They don't understand structured patterns like Aadhaar (`\d{4}\s\d{4}\s\d{4}`) or PAN (`[A-Z]{5}\d{4}[A-Z]`). They'd miss most Indian government IDs.

### Attempt 3: "I'll use BOTH — regex for structured data, NER for names"
**This is the final solution.** Regex catches structured IDs with 100% precision. NER catches contextual entities with ~95% precision. Together, they cover both categories.

### Attempt 4: "I'll sanitize when the PDF is first uploaded"
**Problem:** If you replace "Rahul Sharma" with "[PERSON_1]" before creating embeddings, the vector for "[PERSON_1] earns ₹25L" is meaningless. Vector search would fail because the embedding model doesn't understand placeholder tokens.

**Solution: JIT (Just-In-Time) sanitization.** Store raw text, generate embeddings from raw text, but sanitize only the Top-K results right before sending to the LLM.

```
❌ Sanitize at ingestion:
   Raw PDF → Sanitize → Chunks → Embeddings → Search → Send to LLM
                ↑ Embeddings are computed on sanitized text = BAD search quality

✅ JIT sanitize:
   Raw PDF → Chunks → Embeddings → Search → Sanitize only Top-K → Send to LLM
                                              ↑ Embeddings computed on raw text = GOOD search quality
```

> **Interview Line:** "I initially considered sanitizing at ingestion time, but that would destroy embedding quality — the vector model would be encoding placeholder tokens instead of real text. So I sanitize just-in-time: only the Top-K chunks retrieved by vector search are sanitized, milliseconds before being sent to the LLM. This preserves search quality while ensuring no raw PII reaches the cloud."

---

## Interview Questions

### Basic
- **Q:** "What types of PII does your system detect?"
- **A:** "Two categories. Structured PII: Aadhaar, PAN, GSTIN, IFSC, phone numbers, emails, SSNs, credit cards, IP addresses, dates of birth, passport numbers, UPI IDs — all via regex. Unstructured PII: person names, organizations, and locations — via a BERT NER model."

### Intermediate
- **Q:** "Why do you replace text right-to-left instead of left-to-right?"
- **A:** "When you replace a substring with a token of different length, all subsequent character positions shift. Left-to-right replacement corrupts the offsets of later matches. Right-to-left replacement only modifies text after the current cursor position, so earlier offsets remain valid."

### Advanced
- **Q:** "How do you ensure the same person gets the same token across different chunks?"
- **A:** "I use a global token registry — a Map keyed by `LABEL::normalized_value`. Every time I detect an entity, I compute its fingerprint, look it up in the registry, and either reuse the existing token or mint a new one. This registry is shared across all chunks AND the user's input query."

### Trap
- **Q:** "What happens if the NER model misses a name?"
- **A:** "It leaks to the LLM. This is a known limitation — NER models have ~95% recall, not 100%. For critical deployments, I'd add a third layer: dictionary-based matching against a list of known sensitive names extracted from the document. I'd also consider adding a manual redaction review step in the UI."

### Design
- **Q:** "Why not sanitize at ingestion time?"
- **A:** "It would destroy vector search quality. Embedding models produce meaningless vectors for placeholder tokens like `[PERSON_1]`. By sanitizing just-in-time, the vector store indexes raw text (which gives accurate semantic search) while the LLM only ever sees sanitized text."

---

**Next Phase → [07_LLM_Integration.md](./07_LLM_Integration.md)** — We'll build the LLM service with SSE streaming and the rehydration system.
