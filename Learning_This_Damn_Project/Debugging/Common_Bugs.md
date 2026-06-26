# Debugging Guide — Common Issues and Fixes

## Issue 1: "Model won't load — SharedArrayBuffer not available"

**Symptom:** Console error: `SharedArrayBuffer is not defined` or `Cannot use SharedArrayBuffer`.

**Root Cause:** ONNX Runtime needs SharedArrayBuffer for multi-threaded WASM execution. Browsers require specific CORS headers after the Spectre vulnerability.

**Fix:** Ensure `vite.config.ts` sets these headers:
```typescript
'Cross-Origin-Opener-Policy': 'same-origin',
'Cross-Origin-Embedder-Policy': 'credentialless'
```

**Verification:** Check browser DevTools → Application → Frames → your origin → look for `crossOriginIsolated: true`.

---

## Issue 2: "Vite fails to pre-bundle @huggingface/transformers"

**Symptom:** Build errors about unresolved imports, or the app crashes when loading a model.

**Root Cause:** Transformers.js uses dynamic `import()` statements that Vite's dependency optimizer can't resolve.

**Fix:** Add to `vite.config.ts`:
```typescript
optimizeDeps: {
  exclude: ['@huggingface/transformers']
}
```

---

## Issue 3: "PDF gives garbled text"

**Possible Causes:**
1. **Scanned PDF** — The PDF is an image, not text. pdf.js can't extract text from images. Fix: Add OCR with Tesseract.js.
2. **Custom font encoding** — The PDF uses a non-standard font mapping. Fix: Try a different PDF or check pdf.js font substitution settings.
3. **Y-threshold too aggressive** — The 4-unit Y threshold might merge separate visual lines. Fix: Increase the threshold.

---

## Issue 4: "PII leaking through sanitization"

**Possible Causes:**
1. **NER model misses the entity** — Unusual names or abbreviations. Fix: Add custom regex rules for known patterns.
2. **Regex doesn't match the format** — e.g., a phone number with unusual spacing. Fix: Update the regex pattern.
3. **Chunk boundary splits a name** — "Rah" in chunk 1, "ul Sharma" in chunk 2. Fix: Increase chunk overlap.

---

## Issue 5: "Worker communication hangs"

**Symptom:** The app seems stuck after sending a request to a worker.

**Debugging Steps:**
1. Check the worker console (DevTools → Sources → Workers)
2. Verify the `requestId` matches between request and response
3. Check if the worker threw an unhandled error (add `onerror` handler)
4. Verify the model downloaded successfully (check Network tab)

---

## Issue 6: "Right-to-left replacement produces garbled text"

**Symptom:** Characters are in the wrong position after sanitization.

**Root Cause:** Spans might be overlapping. Two different regex rules match overlapping text regions.

**Fix:** Run `collapseOverlaps()` on all spans before replacement. Ensure spans are sorted by `start` descending.

---

## Issue 7: "Rehydration shows [PERSON_1] instead of the real name"

**Possible Causes:**
1. **Token not in dictionary** — The LLM generated a token that wasn't in the original sanitization. Fix: Check the merged dictionary.
2. **Prefix collision** — `[PERSON_1]` was replaced before `[PERSON_10]`. Fix: Sort tokens longest-first before replacement.
3. **LLM modified the token format** — The LLM wrote `PERSON_1` without brackets. Fix: Adjust the rehydration regex to handle bracket-less variants.

---

## Issue 8: "SSE streaming stops mid-response"

**Possible Causes:**
1. **Rate limit hit** — Groq has rate limits on free tier. Fix: Add retry logic with exponential backoff.
2. **Network interruption** — Fix: Add error handling in the stream reader loop.
3. **Token limit reached** — The response hit `max_tokens`. Check `finish_reason === 'length'` and display a warning.
