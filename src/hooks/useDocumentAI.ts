import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Chunker } from '@/lib/Chunker';
import { PDFExtractor, type PDFExtractionResult } from '@/lib/PDFExtractor';
import {
  VectorStore,
  type VectorSearchResult,
  type VectorStoreInsert
} from '@/lib/VectorStore';
import type {
  EmbeddingWorkerCompleteMessage,
  EmbeddingWorkerRequest,
  EmbeddingWorkerResponse,
  NERWorkerCompleteMessage,
  NERWorkerRequest,
  NERWorkerResponse,
  RedactionResult,
  WorkerStatusMessage
} from '@/workers/types';
import { requestSecureCompletion } from '@/services/llmService';
import { rehydrateResponse } from '@/utils/rehydration';
import {
  type PIIDefense,
  PII_DEFENSES,
  CHUNK_PII_DEFENSES,
  TOKEN_PATTERN,
  isTitleCaseEntity,
  normalizeLedgerKey,
  canonicalizeTokenLabel
} from '@/utils/piiDefenses';

export type DocumentAIPhase =
  | 'idle'
  | 'initializing'
  | 'processing-document'
  | 'ready'
  | 'querying'
  | 'error';

export interface DocumentChunkMetadata {
  chunkIndex: number;
  length: number;
}

export interface RedactedSearchResult {
  id: string;
  score: number;
  redactedText: string;
  dictionary: RedactionResult['dictionary'];
  spans: RedactionResult['spans'];
  metadata?: DocumentChunkMetadata;
}

export interface DocumentAIWorkerState {
  stage: DocumentAIPhase | WorkerStatusMessage['stage'];
  message: string;
  progress?: number;
  model?: string;
  device?: 'webgpu' | 'wasm';
}

export interface UseDocumentAIState {
  phase: DocumentAIPhase;
  documentName: string | null;
  pageCount: number;
  chunkCount: number;
  extraction: PDFExtractionResult | null;
  results: RedactedSearchResult[];
  error: string | null;
  queryStatusMessage: string | null;
  streamingMessage: StreamingAssistantMessage | null;
  embeddingWorker: DocumentAIWorkerState;
  nerWorker: DocumentAIWorkerState;
}

export interface UseDocumentAIReturn extends UseDocumentAIState {
  processDocument: (file: File) => Promise<void>;
  queryDocument: (
    query: string,
    options?: QueryDocumentOptions
  ) => Promise<DocumentAIQueryResponse>;
  clearDocument: () => void;
}

export interface UseDocumentAIOptions {
  semanticThreshold?: number;
}

export interface QueryDocumentOptions {
  privacyShieldEnabled?: boolean;
}

export interface PhantomHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type SemanticRoute = 'document' | 'general';

export interface StreamingAssistantMessage {
  content: string;
  createdAt: number;
  route: SemanticRoute;
  routeMessage: string;
  privacyShieldEnabled: boolean;
  metaIntentOverride: boolean;
  semanticScore: number;
  semanticThreshold: number;
  sanitizedInput: string;
  sanitizedInputDictionary: RedactionResult['dictionary'];
  redactedMatches: RedactedSearchResult[];
}

export interface DocumentAIQueryResponse {
  answer: string;
  sanitizedAnswer: string;
  sanitizedInput: string;
  sanitizedInputDictionary: RedactionResult['dictionary'];
  redactedMatches: RedactedSearchResult[];
  tokenDictionary: Record<string, string>;
  route: SemanticRoute;
  routeMessage: string;
  privacyShieldEnabled: boolean;
  metaIntentOverride: boolean;
  semanticScore: number;
  semanticThreshold: number;
}

interface WorkerRequestHandlers<TComplete> {
  resolve: (message: TComplete) => void;
  reject: (reason?: unknown) => void;
}

interface PrefilteredTextRedaction {
  redactedText: string;
  dictionary: RedactionResult['dictionary'];
  tokenDictionary: Record<string, string>;
  appliedCount: number;
}

const DEFAULT_WORKER_STATE: DocumentAIWorkerState = {
  stage: 'idle',
  message: 'Not initialized.'
};

export const DEFAULT_SEMANTIC_THRESHOLD = 0.12;
const META_QUERY_PATTERN =
  /\b(summarize|summary|this pdf|the pdf|this document|the document)\b/i;
const EMBEDDING_BATCH_SIZE = 20;
const LARGE_DOCUMENT_CHUNK_THRESHOLD = 100;
const SMALL_DOCUMENT_TOP_K = 5;
const LARGE_DOCUMENT_TOP_K = 15;
const META_INTENT_TOP_K = 15;
const DEFAULT_PRIVACY_SHIELD_ENABLED = true;

export function useDocumentAI({
  semanticThreshold = DEFAULT_SEMANTIC_THRESHOLD
}: UseDocumentAIOptions = {}): UseDocumentAIReturn {
  const embeddingWorkerRef = useRef<Worker | null>(null);
  const nerWorkerRef = useRef<Worker | null>(null);
  const vectorStoreRef = useRef(new VectorStore<DocumentChunkMetadata>());
  const pendingEmbeddingRequestsRef = useRef(
    new Map<
      string,
      WorkerRequestHandlers<EmbeddingWorkerCompleteMessage>
    >()
  );
  const pendingNERRequestsRef = useRef(
    new Map<string, WorkerRequestHandlers<NERWorkerCompleteMessage>>()
  );
  const [phase, setPhase] = useState<DocumentAIPhase>('idle');
  const [documentName, setDocumentName] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [chunkCount, setChunkCount] = useState(0);
  const [extraction, setExtraction] = useState<PDFExtractionResult | null>(null);
  const [results, setResults] = useState<RedactedSearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [queryStatusMessage, setQueryStatusMessage] = useState<string | null>(
    null
  );
  const [streamingMessage, setStreamingMessage] =
    useState<StreamingAssistantMessage | null>(null);
  const [phantomHistory, setPhantomHistory] = useState<PhantomHistoryMessage[]>(
    []
  );
  const [embeddingWorker, setEmbeddingWorker] =
    useState<DocumentAIWorkerState>(DEFAULT_WORKER_STATE);
  const [nerWorker, setNerWorker] =
    useState<DocumentAIWorkerState>(DEFAULT_WORKER_STATE);
  const globalTokenDictionaryRef = useRef<Record<string, string>>({});
  const tokenRegistryRef = useRef(new Map<string, string>());
  const tokenCountersRef = useRef<Record<string, number>>({});

  const chunker = useMemo(() => new Chunker(), []);

  useEffect(() => {
    let isCancelled = false;

    const embeddingWorker = new Worker(
      new URL('../workers/embedding-worker.ts', import.meta.url),
      { type: 'module' }
    );
    const nerWorker = new Worker(
      new URL('../workers/ner-worker.ts', import.meta.url),
      { type: 'module' }
    );

    embeddingWorkerRef.current = embeddingWorker;
    nerWorkerRef.current = nerWorker;

    embeddingWorker.onmessage = (
      event: MessageEvent<EmbeddingWorkerResponse>
    ) => {
      handleEmbeddingWorkerMessage(event.data);
    };

    nerWorker.onmessage = (event: MessageEvent<NERWorkerResponse>) => {
      handleNERWorkerMessage(event.data);
    };

    embeddingWorker.onerror = (event: ErrorEvent) => {
      if (isCancelled) return;
      const message =
        event.message || 'Embedding worker encountered an unexpected error.';
      console.error('Embedding worker error:', event);

      for (const pending of pendingEmbeddingRequestsRef.current.values()) {
        pending.reject(new Error(message));
      }
      pendingEmbeddingRequestsRef.current.clear();

      setError(message);
      setPhase('error');
    };

    nerWorker.onerror = (event: ErrorEvent) => {
      if (isCancelled) return;
      const message =
        event.message || 'NER worker encountered an unexpected error.';
      console.error('NER worker error:', event);

      for (const pending of pendingNERRequestsRef.current.values()) {
        pending.reject(new Error(message));
      }
      pendingNERRequestsRef.current.clear();

      setError(message);
      setPhase('error');
    };

    setPhase('initializing');

    initializeWorkers()
      .then(() => {
        if (!isCancelled) {
          setPhase('idle');
        }
      })
      .catch((initError: unknown) => {
        if (isCancelled) {
          return;
        }

        const message =
          initError instanceof Error
            ? initError.message
            : 'Worker initialization failed.';

        if (message.includes('worker was terminated')) {
          return;
        }

        console.error('Failed to initialize workers:', initError);
        setError(message);
        setPhase('error');
      });

    return () => {
      isCancelled = true;
      embeddingWorker.terminate();
      nerWorker.terminate();
      embeddingWorkerRef.current = null;
      nerWorkerRef.current = null;

      for (const pending of pendingEmbeddingRequestsRef.current.values()) {
        pending.reject(new Error('Embedding worker was terminated.'));
      }
      pendingEmbeddingRequestsRef.current.clear();

      for (const pending of pendingNERRequestsRef.current.values()) {
        pending.reject(new Error('NER worker was terminated.'));
      }
      pendingNERRequestsRef.current.clear();
    };
  }, []);

  const handleEmbeddingWorkerMessage = (message: EmbeddingWorkerResponse): void => {
    if (message.type === 'status') {
      startTransition(() => {
        setEmbeddingWorker({
          stage: message.stage,
          message: message.message,
          progress: message.progress,
          model: message.model,
          device: message.device
        });
      });
      return;
    }

    if (message.type === 'error') {
      const pendingRequest = message.requestId
        ? pendingEmbeddingRequestsRef.current.get(message.requestId)
        : undefined;

      if (pendingRequest) {
        pendingEmbeddingRequestsRef.current.delete(message.requestId!);
        pendingRequest.reject(new Error(message.message));
      }

      setError(message.message);
      setPhase('error');
      return;
    }

    const pendingRequest = pendingEmbeddingRequestsRef.current.get(
      message.requestId
    );

    if (pendingRequest) {
      pendingEmbeddingRequestsRef.current.delete(message.requestId);
      pendingRequest.resolve(message);
    }
  };

  const handleNERWorkerMessage = (message: NERWorkerResponse): void => {
    if (message.type === 'status') {
      startTransition(() => {
        setNerWorker({
          stage: message.stage,
          message: message.message,
          progress: message.progress,
          model: message.model,
          device: message.device
        });
      });
      return;
    }

    if (message.type === 'error') {
      const pendingRequest = message.requestId
        ? pendingNERRequestsRef.current.get(message.requestId)
        : undefined;

      if (pendingRequest) {
        pendingNERRequestsRef.current.delete(message.requestId!);
        pendingRequest.reject(new Error(message.message));
      }

      setError(message.message);
      setPhase('error');
      return;
    }

    const pendingRequest = pendingNERRequestsRef.current.get(message.requestId);

    if (pendingRequest) {
      pendingNERRequestsRef.current.delete(message.requestId);
      pendingRequest.resolve(message);
    }
  };

  const initializeWorkers = async (): Promise<void> => {
    await Promise.all([
      sendEmbeddingRequest({
        type: 'init',
        requestId: uuidv4()
      }),
      sendNERRequest({
        type: 'init',
        requestId: uuidv4()
      })
    ]);
  };

  const processDocument = async (file: File): Promise<void> => {
    setError(null);
    setDocumentName(null);
    setPageCount(0);
    setChunkCount(0);
    setExtraction(null);
    setResults([]);
    setQueryStatusMessage(null);
    setStreamingMessage(null);
    setPhase('processing-document');
    vectorStoreRef.current.clear();
    resetConversationMemory();

    try {
      const extracted = await PDFExtractor.extract(file);
      const chunks = chunker.split(extracted.fullText);
      const embeddings = await embedTexts(chunks.map((chunk) => chunk.text));

      const records: VectorStoreInsert<DocumentChunkMetadata>[] = chunks.map(
        (chunk, index) => ({
          text: chunk.text,
          embedding: embeddings[index],
          metadata: {
            chunkIndex: chunk.index,
            length: chunk.length
          }
        })
      );

      vectorStoreRef.current.addMany(records);

      startTransition(() => {
        setDocumentName(file.name);
        setPageCount(extracted.pageCount);
        setChunkCount(chunks.length);
        setExtraction(extracted);
        setPhase('ready');
      });
    } catch (processingError) {
      const message =
        processingError instanceof Error
          ? processingError.message
          : 'Failed to process document.';
      setError(message);
      setPhase('error');
      throw processingError;
    }
  };

  const queryDocument = async (
    query: string,
    options: QueryDocumentOptions = {}
  ): Promise<DocumentAIQueryResponse> => {
    const trimmedQuery = query.trim();
    const privacyShieldEnabled =
      options.privacyShieldEnabled ?? DEFAULT_PRIVACY_SHIELD_ENABLED;

    if (!trimmedQuery) {
      return {
        answer: '',
        sanitizedAnswer: '',
        sanitizedInput: '',
        sanitizedInputDictionary: {},
        redactedMatches: [],
        tokenDictionary: {},
        route: 'general',
        routeMessage: 'Bypassing document index (empty query). Engaging general AI mode.',
        privacyShieldEnabled,
        metaIntentOverride: false,
        semanticScore: 0,
        semanticThreshold
      };
    }

    setError(null);
    setQueryStatusMessage('Sanitizing input...');
    setPhase('querying');

    try {
      const {
        sanitizedInput,
        sanitizedInputDictionary,
        tokenDictionary: inputTokenDictionary
      } = privacyShieldEnabled
          ? await sanitizeInputWithDefenses(trimmedQuery)
          : {
            sanitizedInput: trimmedQuery,
            sanitizedInputDictionary: {},
            tokenDictionary: {}
          };
      const nextPhantomHistory = [
        ...phantomHistory,
        {
          role: 'user' as const,
          content: sanitizedInput
        }
      ];

      setPhantomHistory(nextPhantomHistory);

      setQueryStatusMessage('Searching document...');
      const totalChunks = vectorStoreRef.current.size();
      const metaIntentOverride =
        totalChunks > 0 && META_QUERY_PATTERN.test(sanitizedInput);
      const retrievalTopK =
        metaIntentOverride
          ? META_INTENT_TOP_K
          : totalChunks > LARGE_DOCUMENT_CHUNK_THRESHOLD
            ? LARGE_DOCUMENT_TOP_K
            : SMALL_DOCUMENT_TOP_K;
      const semanticMatches =
        totalChunks > 0
          ? vectorStoreRef.current.search(
            (await embedTexts([trimmedQuery]))[0],
            retrievalTopK
          )
          : [];
      const topSemanticScore = semanticMatches[0]?.score ?? 0;
      const route: SemanticRoute =
        metaIntentOverride ||
          (semanticMatches.length > 0 && topSemanticScore >= semanticThreshold)
          ? 'document'
          : 'general';
      const routeMessage =
        metaIntentOverride
          ? 'Meta-intent override detected. Using local document context for a document-level request.'
          : route === 'document'
            ? `Using document context (${(topSemanticScore * 100).toFixed(1)}% semantic match).`
            : semanticMatches.length === 0
              ? 'Bypassing document index (no local document context available). Engaging general AI mode.'
              : 'Bypassing document index (low semantic match). Engaging general AI mode.';
      const routedMatches =
        route === 'document'
          ? semanticMatches.slice(0, retrievalTopK)
          : [];

      const { redactedMatches, tokenDictionary: chunkTokenDictionary } =
        route === 'document'
          ? await sanitizeDocumentChunksJIT(
            routedMatches,
            privacyShieldEnabled
          )
          : {
            redactedMatches: [],
            tokenDictionary: {}
          };
      const tokenDictionary = {
        ...globalTokenDictionaryRef.current,
        ...inputTokenDictionary,
        ...chunkTokenDictionary
      };
      const streamingContext = {
        createdAt: Date.now(),
        route,
        routeMessage,
        privacyShieldEnabled,
        metaIntentOverride,
        semanticScore: topSemanticScore,
        semanticThreshold,
        sanitizedInput,
        sanitizedInputDictionary,
        redactedMatches
      };
      let rawAccumulatedAnswer = '';

      setQueryStatusMessage(
        route === 'document'
          ? 'Streaming document response...'
          : 'Streaming general AI response...'
      );
      setStreamingMessage({
        ...streamingContext,
        content: ''
      });
      const sanitizedAnswer = await requestSecureCompletion({
        conversationHistory: nextPhantomHistory,
        sanitizedChunks: redactedMatches.map((match) => match.redactedText),
        useContext: route === 'document',
        onDelta: (delta) => {
          rawAccumulatedAnswer += delta;

          startTransition(() => {
            setStreamingMessage({
              ...streamingContext,
              content: sanitizeStreamingDisplay(
                rehydrateResponse(
                  rawAccumulatedAnswer,
                  globalTokenDictionaryRef.current
                )
              )
            });
          });
        }
      });
      setPhantomHistory([
        ...nextPhantomHistory,
        {
          role: 'assistant',
          content: sanitizedAnswer
        }
      ]);

      const answer = rehydrateResponse(
        sanitizedAnswer,
        globalTokenDictionaryRef.current
      );

      startTransition(() => {
        setResults(redactedMatches);
        setStreamingMessage(null);
        setQueryStatusMessage(null);
        setPhase('ready');
      });

      return {
        answer,
        sanitizedAnswer,
        sanitizedInput,
        sanitizedInputDictionary,
        redactedMatches,
        tokenDictionary,
        route,
        routeMessage,
        privacyShieldEnabled,
        metaIntentOverride,
        semanticScore: topSemanticScore,
        semanticThreshold
      };
    } catch (queryError) {
      const message =
        queryError instanceof Error ? queryError.message : 'Query failed.';
      setError(message);
      setStreamingMessage(null);
      setQueryStatusMessage(null);
      setPhase('error');
      throw queryError;
    }
  };

  const clearDocument = (): void => {
    vectorStoreRef.current.clear();
    resetConversationMemory();
    setDocumentName(null);
    setPageCount(0);
    setChunkCount(0);
    setExtraction(null);
    setResults([]);
    setError(null);
    setQueryStatusMessage(null);
    setStreamingMessage(null);
    setPhase('idle');
  };

  const sendEmbeddingRequest = (
    request: EmbeddingWorkerRequest
  ): Promise<EmbeddingWorkerCompleteMessage> => {
    const worker = embeddingWorkerRef.current;
    if (!worker) {
      return Promise.reject(new Error('Embedding worker is not available.'));
    }

    return new Promise<EmbeddingWorkerCompleteMessage>((resolve, reject) => {
      pendingEmbeddingRequestsRef.current.set(request.requestId, {
        resolve,
        reject
      });

      worker.postMessage(request);
    });
  };

  const sendNERRequest = (
    request: NERWorkerRequest
  ): Promise<NERWorkerCompleteMessage> => {
    const worker = nerWorkerRef.current;
    if (!worker) {
      return Promise.reject(new Error('NER worker is not available.'));
    }

    return new Promise<NERWorkerCompleteMessage>((resolve, reject) => {
      pendingNERRequestsRef.current.set(request.requestId, {
        resolve,
        reject
      });

      worker.postMessage(request);
    });
  };

  const embedTexts = async (texts: string[]): Promise<Float32Array[]> => {
    if (texts.length === 0) {
      return [];
    }

    const allEmbeddings = new Array<Float32Array | null>(texts.length).fill(null);
    let embeddingDimension = 0;

    for (let startIndex = 0; startIndex < texts.length; startIndex += EMBEDDING_BATCH_SIZE) {
      const batchEntries = texts
        .slice(startIndex, startIndex + EMBEDDING_BATCH_SIZE)
        .map((text, offset) => ({
          index: startIndex + offset,
          text
        }))
        .filter((entry) => entry.text.trim().length > 0);

      if (batchEntries.length === 0) {
        continue;
      }

      const response = await sendEmbeddingRequest({
        type: 'embed',
        requestId: uuidv4(),
        payload: {
          texts: batchEntries.map((entry) => entry.text)
        }
      });

      if (response.embeddings.length !== batchEntries.length) {
        throw new Error('Embedding worker returned an unexpected batch size.');
      }

      if (response.dimension > 0) {
        embeddingDimension = response.dimension;
      }

      batchEntries.forEach((entry, batchIndex) => {
        allEmbeddings[entry.index] = response.embeddings[batchIndex];
      });
    }

    if (embeddingDimension === 0) {
      return [];
    }

    return allEmbeddings.map((embedding, index) => {
      if (embedding) {
        return embedding;
      }

      console.warn(
        `Embedding batch skipped an empty text at index ${index}. Falling back to a zero vector.`
      );
      return new Float32Array(embeddingDimension);
    });
  };

  const redactTexts = async (texts: string[]): Promise<RedactionResult[]> => {
    const response = await sendNERRequest({
      type: 'redact',
      requestId: uuidv4(),
      payload: {
        texts
      }
    });

    return response.results;
  };

  const resetConversationMemory = (): void => {
    setPhantomHistory([]);
    globalTokenDictionaryRef.current = {};
    tokenRegistryRef.current = new Map<string, string>();
    tokenCountersRef.current = {};
  };

  const sanitizeInputWithDefenses = async (rawInput: string) => {
    const prefilteredInput = applyPIIDefenses(rawInput, PII_DEFENSES);

    if (!shouldRunNERForInput(prefilteredInput.redactedText)) {
      return {
        sanitizedInput: prefilteredInput.redactedText,
        sanitizedInputDictionary: prefilteredInput.dictionary,
        tokenDictionary: prefilteredInput.tokenDictionary
      };
    }

    const [inputRedaction] = await redactTexts([prefilteredInput.redactedText]);

    return promoteInputRedaction(inputRedaction, prefilteredInput);
  };

  const sanitizeDocumentChunksJIT = async (
    matches: VectorSearchResult<DocumentChunkMetadata>[],
    privacyShieldEnabled: boolean
  ) => {
    if (!privacyShieldEnabled) {
      return {
        redactedMatches: matches.map((match) => ({
          id: match.id,
          score: match.score,
          redactedText: match.text,
          dictionary: {},
          spans: [],
          metadata: match.metadata
        })),
        tokenDictionary: {}
      };
    }

    const prefilteredChunks = matches.map((match) =>
      applyPIIDefenses(match.text, CHUNK_PII_DEFENSES)
    );
    const workerResults = await redactTexts(
      prefilteredChunks.map((chunk) => chunk.redactedText)
    );
    const tokenDictionary: Record<string, string> = {};

    const redactedMatches = matches.map((match, index) => {
      const prefilteredChunk = prefilteredChunks[index];
      const workerResult = workerResults[index];
      const promotedWorkerResult = workerResult
        ? promoteSanitizedText({
          redactedText: workerResult.redactedText,
          dictionary: workerResult.dictionary,
          spans: workerResult.spans
        })
        : {
          redactedText: prefilteredChunk.redactedText,
          dictionary: {},
          spans: [],
          tokenDictionary: {}
        };

      Object.assign(tokenDictionary, prefilteredChunk.tokenDictionary);
      Object.assign(tokenDictionary, promotedWorkerResult.tokenDictionary);

      return {
        id: match.id,
        score: match.score,
        redactedText: promotedWorkerResult.redactedText,
        dictionary: {
          ...prefilteredChunk.dictionary,
          ...promotedWorkerResult.dictionary
        },
        spans: promotedWorkerResult.spans,
        metadata: match.metadata
      };
    });

    return {
      redactedMatches,
      tokenDictionary
    };
  };

  const applyPIIDefenses = (
    rawInput: string,
    defenses: PIIDefense[]
  ): PrefilteredTextRedaction => {
    let redactedText = rawInput;
    const dictionary: RedactionResult['dictionary'] = {};
    const tokenDictionary: Record<string, string> = {};
    let appliedCount = 0;

    for (const defense of defenses) {
      defense.regex.lastIndex = 0;

      redactedText = redactedText.replace(defense.regex, (...args) => {
        const fullMatch = args[0];
        const capturedValue =
          typeof defense.captureGroup === 'number'
            ? String(args[defense.captureGroup] ?? '')
            : fullMatch;
        const originalValue = capturedValue.trim();

        if (
          !originalValue ||
          TOKEN_PATTERN.test(originalValue) ||
          (defense.requireTitleCase && !isTitleCaseEntity(originalValue))
        ) {
          return fullMatch;
        }

        const sessionToken = getOrCreateSessionToken(defense.tag, originalValue);
        const normalizedTag = canonicalizeTokenLabel(defense.tag);

        dictionary[sessionToken] = {
          label: normalizedTag,
          original: originalValue
        };
        tokenDictionary[sessionToken] = originalValue;
        appliedCount += 1;

        if (typeof defense.captureGroup === 'number') {
          return fullMatch.replace(originalValue, sessionToken);
        }

        return sessionToken;
      });
    }

    return {
      redactedText,
      dictionary,
      tokenDictionary,
      appliedCount
    };
  };

  const promoteInputRedaction = (
    inputRedaction: RedactionResult,
    prefilteredInput?: PrefilteredTextRedaction
  ) => {
    const {
      redactedText: sanitizedInput,
      dictionary: sanitizedInputDictionary,
      tokenDictionary
    } = promoteSanitizedText({
      redactedText: inputRedaction.redactedText,
      dictionary: inputRedaction.dictionary,
      spans: inputRedaction.spans
    });

    return {
      sanitizedInput,
      sanitizedInputDictionary: {
        ...(prefilteredInput?.dictionary ?? {}),
        ...sanitizedInputDictionary
      },
      tokenDictionary: {
        ...(prefilteredInput?.tokenDictionary ?? {}),
        ...tokenDictionary
      }
    };
  };

  const promoteSanitizedText = ({
    redactedText,
    dictionary,
    spans
  }: Pick<RedactionResult, 'redactedText' | 'dictionary' | 'spans'>) => {
    let promotedText = redactedText;
    const promotedDictionary: RedactionResult['dictionary'] = {};
    const promotedSpans = spans.map((span) => ({ ...span }));
    const tokenDictionary: Record<string, string> = {};

    for (const [token, entry] of Object.entries(dictionary)) {
      const sessionToken = getOrCreateSessionToken(entry.label, entry.original);
      promotedText = promotedText.replaceAll(token, sessionToken);
      promotedDictionary[sessionToken] = entry;
      tokenDictionary[sessionToken] = entry.original;

      for (const span of promotedSpans) {
        if (span.placeholder === token) {
          span.placeholder = sessionToken;
        }
      }
    }

    return {
      redactedText: promotedText,
      dictionary: promotedDictionary,
      spans: promotedSpans,
      tokenDictionary
    };
  };

  const getOrCreateSessionToken = (label: string, original: string): string => {
    const normalizedLabel = canonicalizeTokenLabel(label);
    const fingerprint = `${normalizedLabel}::${normalizeLedgerKey(original)}`;
    const existingToken = tokenRegistryRef.current.get(fingerprint);

    if (existingToken) {
      return existingToken;
    }

    const nextIndex = (tokenCountersRef.current[normalizedLabel] ?? 0) + 1;
    tokenCountersRef.current[normalizedLabel] = nextIndex;

    const sessionToken = `[${normalizedLabel}_${nextIndex}]`;

    tokenRegistryRef.current.set(fingerprint, sessionToken);
    globalTokenDictionaryRef.current[sessionToken] = original;

    return sessionToken;
  };

  return {
    phase,
    documentName,
    pageCount,
    chunkCount,
    extraction,
    results,
    error,
    queryStatusMessage,
    streamingMessage,
    embeddingWorker,
    nerWorker,
    processDocument,
    queryDocument,
    clearDocument
  };
}

function shouldRunNERForInput(text: string): boolean {
  const remainder = text.replace(new RegExp(TOKEN_PATTERN.source, 'g'), ' ').trim();

  return /[A-Za-z]{2,}/.test(remainder);
}

function sanitizeStreamingDisplay(text: string): string {
  const lastOpenBracket = text.lastIndexOf('[');
  const lastCloseBracket = text.lastIndexOf(']');

  if (lastOpenBracket <= lastCloseBracket) {
    return text;
  }

  const trailingFragment = text.slice(lastOpenBracket + 1);

  return /^[A-Z0-9_]+$/.test(trailingFragment)
    ? text.slice(0, lastOpenBracket)
    : text;
}
