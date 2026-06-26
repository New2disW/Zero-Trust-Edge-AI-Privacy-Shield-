# Interview Questions — By Topic

## PDF Extraction
1. How does pdf.js work internally?
2. Why not use `File.text()` for PDFs?
3. What is the Y-position grouping algorithm?
4. How do you handle scanned PDFs (image-only)?
5. What does `isEvalSupported: false` do?

## Chunking
6. Why not send the entire document to the LLM?
7. Explain the recursive splitting algorithm.
8. Why use overlapping chunks? What's the tradeoff?
9. What happens at chunk boundaries without overlap?
10. Why this specific separator hierarchy?

## Vector Search
11. What is an embedding?
12. Explain cosine similarity vs Euclidean distance.
13. What's the time complexity of your search?
14. Why brute-force instead of ANN (like HNSW)?
15. Why pre-cache magnitudes?
16. Why `Float32Array` instead of `number[]`?

## Web Workers
17. Why use Web Workers for AI inference?
18. What's the Singleton pattern and why use it here?
19. How do you correlate requests and responses?
20. What are Transferable objects?
21. What's the difference between WebGPU and WASM execution?
22. How do you handle worker crashes?

## Privacy / Sanitization
23. What types of PII does your system detect?
24. Why regex + NER instead of just one?
25. Explain the right-to-left replacement algorithm.
26. What is the global token ledger?
27. Why JIT sanitization instead of ingestion-time?
28. What happens if the NER model misses a name?
29. How do you handle overlapping NER spans?

## LLM Integration
30. How does SSE streaming work?
31. What is rehydration?
32. Explain the prefix collision problem in rehydration.
33. What is semantic routing?
34. Why did you choose Groq over OpenAI?

## Architecture
35. Walk me through the complete data flow.
36. Why is everything client-side?
37. How would you scale this to multiple users?
38. Why `useRef` instead of `useState` for the VectorStore?
39. How do you prevent memory leaks with Workers?
40. What security headers do you set and why?

## Design Patterns
41. Name all design patterns used in this project.
42. Why Singleton for model loading?
43. Where is the Strategy pattern used?
44. Where is the Observer/Pub-Sub pattern used?
45. Where is the Factory pattern used?

## Trap Questions
46. Did you build the AI models from scratch?
47. Is this just a wrapper around Transformers.js?
48. Why not use LangChain?
49. Is this production-ready?
50. Your VectorStore is O(n) — isn't that slow?
