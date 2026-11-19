/// <reference lib="webworker" />

import {
  env,
  pipeline,
  type ProgressInfo,
  type TokenClassificationOutput,
  type TokenClassificationPipelineType
} from '@huggingface/transformers';
import ortWasmSimdThreadedJsepMjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url';
import ortWasmSimdThreadedJsepWasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';
import ortWasmSimdThreadedMjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';
import ortWasmSimdThreadedWasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import type {
  NERWorkerCompleteMessage,
  NERWorkerRequest,
  NERWorkerResponse,
  RedactionDictionaryEntry,
  RedactionResult,
  RedactionSpan,
  WorkerErrorMessage,
  WorkerStatusMessage
} from './types';

const MODEL_NAME = 'Xenova/bert-base-NER';
let activeDevice: 'webgpu' | 'wasm' = 'wasm';

const configureONNXEnvironment = env.backends.onnx as {
  wasm?: {
    wasmPaths?:
      | string
      | {
          mjs?: string;
          wasm?: string;
        };
  };
};
const createTokenClassificationPipeline = pipeline as (
  task: 'token-classification',
  model: string,
  options: {
    progress_callback?: (progress: ProgressInfo) => void;
    device: 'webgpu' | 'wasm';
    dtype?: 'q8' | string;
  }
) => Promise<TokenClassificationPipelineType>;

env.allowLocalModels = false;
env.useBrowserCache = true;

function isNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('failed to fetch') ||
      message.includes('networkerror') ||
      message.includes('network error') ||
      message.includes('load failed')
    );
  }
  return false;
}

interface NavigatorWithGPU {
  gpu?: {
    requestAdapter: () => Promise<unknown>;
  };
}

async function detectDevice(): Promise<'webgpu' | 'wasm'> {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      const gpu = (navigator as unknown as NavigatorWithGPU).gpu;
      const adapter = await gpu?.requestAdapter();
      if (adapter) {
        return 'webgpu';
      }
    } catch {
      return 'wasm';
    }
  }
  return 'wasm';
}

function setWasmPaths(device: 'webgpu' | 'wasm'): void {
  configureONNXEnvironment.wasm = configureONNXEnvironment.wasm ?? {};
  configureONNXEnvironment.wasm.wasmPaths =
    device === 'webgpu'
      ? {
          mjs: ortWasmSimdThreadedJsepMjsUrl,
          wasm: ortWasmSimdThreadedJsepWasmUrl
        }
      : {
          mjs: ortWasmSimdThreadedMjsUrl,
          wasm: ortWasmSimdThreadedWasmUrl
        };
}

class NERPipelineSingleton {
  private static instance: Promise<TokenClassificationPipelineType> | null = null;

  static async getInstance(
    progress_callback?: (progress: ProgressInfo) => void
  ): Promise<TokenClassificationPipelineType> {
    if (!this.instance) {
      this.instance = (async () => {
        const device = await detectDevice();
        activeDevice = device;
        setWasmPaths(activeDevice);

        if (activeDevice === 'webgpu') {
          try {
            return await createTokenClassificationPipeline(
              'token-classification',
              MODEL_NAME,
              {
                progress_callback,
                device: 'webgpu',
                dtype: 'q8'
              }
            );
          } catch (error) {
            if (isNetworkError(error)) {
              throw error;
            }

            console.warn(
              'WebGPU initialization failed for NER pipeline, falling back to WASM.',
              error
            );
            activeDevice = 'wasm';
            setWasmPaths('wasm');
            try {
              return await createTokenClassificationPipeline(
                'token-classification',
                MODEL_NAME,
                {
                  progress_callback,
                  device: 'wasm',
                  dtype: 'q8'
                }
              );
            } catch (wasmError) {
              console.error(
                'WASM fallback also failed for NER pipeline:',
                wasmError
              );
              throw wasmError;
            }
          }
        }

        return await createTokenClassificationPipeline(
          'token-classification',
          MODEL_NAME,
          {
            progress_callback,
            device: 'wasm',
            dtype: 'q8'
          }
        );
      })().catch((err) => {
        this.instance = null;
        throw err;
      });
    }

    return this.instance;
  }
}

const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.onmessage = async (event: MessageEvent<NERWorkerRequest>) => {
  const { data } = event;

  try {
    switch (data.type) {
      case 'init': {
        await initializeModel(data.requestId);
        break;
      }
      case 'redact': {
        await redactTexts(data.requestId, data.payload.texts);
        break;
      }
      default: {
        postError('Unsupported NER worker message type.', data);
      }
    }
  } catch (error) {
    postError(error instanceof Error ? error.message : 'NER worker failed.', data);
  }
};

async function initializeModel(requestId: string): Promise<void> {
  postStatus({
    requestId,
    stage: 'init',
    message: 'Initializing redaction pipeline...'
  });

  await NERPipelineSingleton.getInstance((progress) => {
    postProgress(progress, requestId);
  });

  postStatus({
    requestId,
    stage: 'ready',
    message: 'Redaction pipeline is ready.'
  });

  const response: NERWorkerCompleteMessage = {
    type: 'complete',
    requestId,
    results: []
  };

  workerScope.postMessage(response satisfies NERWorkerResponse);
}

async function redactTexts(requestId: string, texts: string[]): Promise<void> {
  if (texts.length === 0) {
    const response: NERWorkerCompleteMessage = {
      type: 'complete',
      requestId,
      results: []
    };
    workerScope.postMessage(response);
    return;
  }

  const classifier = await NERPipelineSingleton.getInstance((progress) => {
    postProgress(progress, requestId);
  });

  postStatus({
    requestId,
    stage: 'ready',
    message: 'Redaction pipeline ready. Detecting entities...'
  });

  const outputs = await classifier(texts, {
    ignore_labels: ['O']
  });

  const normalizedOutputs = Array.isArray(outputs[0])
    ? (outputs as TokenClassificationOutput[])
    : [outputs as TokenClassificationOutput];

  const results = normalizedOutputs.map((output, index) =>
    buildRedactionResult(texts[index], output)
  );

  const response: NERWorkerCompleteMessage = {
    type: 'complete',
    requestId,
    results
  };

  workerScope.postMessage(response satisfies NERWorkerResponse);
}

function buildRedactionResult(
  sourceText: string,
  predictions: TokenClassificationOutput
): RedactionResult {
  const aggregated = aggregateEntitySpans(sourceText, predictions);
  const rawSpans = collapseOverlaps(aggregated, sourceText);
  const spans = rawSpans
    .map((span) => {
      const trimmed = trimSpanOffsets(sourceText, span.start, span.end);
      return {
        ...span,
        start: trimmed.start,
        end: trimmed.end,
        text: trimmed.text
      };
    })
    .filter((span) => span.text.length > 0);

  const dictionary: Record<string, RedactionDictionaryEntry> = {};
  const placeholderByEntity = new Map<string, string>();
  const labelCounts = new Map<string, number>();
  const replacements = [...spans].sort((left, right) => right.start - left.start);
  let redactedText = sourceText;

  for (const span of replacements) {
    const normalizedKey = `${span.label}:${span.text.trim().toLowerCase()}`;
    let placeholder = placeholderByEntity.get(normalizedKey);

    if (!placeholder) {
      const nextCount = labelCounts.get(span.label) ?? 0;
      placeholder = `[${span.label}_${toAlphabeticSuffix(nextCount)}]`;
      placeholderByEntity.set(normalizedKey, placeholder);
      labelCounts.set(span.label, nextCount + 1);
      dictionary[placeholder] = {
        label: span.label,
        original: span.text
      };
    }

    redactedText =
      redactedText.slice(0, span.start) +
      placeholder +
      redactedText.slice(span.end);

    span.placeholder = placeholder;
  }

  return {
    originalText: sourceText,
    redactedText,
    dictionary,
    spans: spans.sort((left, right) => left.start - right.start)
  };
}

function trimSpanOffsets(
  sourceText: string,
  start: number,
  end: number
): { start: number; end: number; text: string } {
  let s = Math.max(0, start);
  let e = Math.min(sourceText.length, end);

  // Strip leading whitespace and delimiter/punctuation characters
  // e.g. colons, commas, dots, dashes, slashes, quotes, brackets, parentheses
  while (s < e && /[\s\r\n\t,;:.'"\-_/[\]()|~<>]/.test(sourceText[s])) {
    s++;
  }

  // Strip trailing whitespace and delimiter/punctuation characters
  while (e > s && /[\s\r\n\t,;:.'"\-_/[\]()|~<>]/.test(sourceText[e - 1])) {
    e--;
  }

  return {
    start: s,
    end: e,
    text: sourceText.slice(s, e)
  };
}

function aggregateEntitySpans(
  sourceText: string,
  predictions: TokenClassificationOutput
): RedactionSpan[] {
  const spans: RedactionSpan[] = [];
  let currentSpan: RedactionSpan | null = null;

  // Protect all pre-existing privacy tokens (both numeric e.g. [ACCOUNT_NUM_1] and alphabetic e.g. [PERSON_A])
  const placeholderRegex = /\[[A-Z][A-Z0-9_]*_[A-Z0-9]+\]/g;
  const placeholderRanges: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = placeholderRegex.exec(sourceText)) !== null) {
    placeholderRanges.push({
      start: match.index,
      end: match.index + match[0].length
    });
  }

  for (const prediction of predictions) {
    if (
      typeof prediction.start !== 'number' ||
      typeof prediction.end !== 'number' ||
      prediction.end <= prediction.start
    ) {
      continue;
    }

    const { start, end } = prediction;
    const overlapsPlaceholder = placeholderRanges.some(
      (range) => start < range.end && end > range.start
    );

    if (overlapsPlaceholder) {
      continue;
    }

    const trimmed = trimSpanOffsets(sourceText, start, end);
    if (!trimmed.text) {
      continue;
    }

    const { prefix, label } = parseEntityLabel(prediction.entity);
    if (!label) {
      continue;
    }

    const nextSpan: RedactionSpan = {
      start: trimmed.start,
      end: trimmed.end,
      label,
      placeholder: '',
      text: trimmed.text,
      score: prediction.score
    };

    const canExtend =
      currentSpan !== null &&
      prefix !== 'B' &&
      currentSpan.label === nextSpan.label &&
      nextSpan.start <= currentSpan.end + 1;

    if (!canExtend || currentSpan === null) {
      if (currentSpan) {
        spans.push(currentSpan);
      }
      currentSpan = nextSpan;
      continue;
    }

    currentSpan.end = Math.max(currentSpan.end, nextSpan.end);
    const combined = trimSpanOffsets(sourceText, currentSpan.start, currentSpan.end);
    currentSpan.start = combined.start;
    currentSpan.end = combined.end;
    currentSpan.text = combined.text;
    currentSpan.score = (currentSpan.score + nextSpan.score) / 2;
  }

  if (currentSpan) {
    spans.push(currentSpan);
  }

  return spans.filter((span) => span.text.length > 0);
}

function collapseOverlaps(spans: RedactionSpan[], sourceText: string): RedactionSpan[] {
  const sortedSpans = [...spans].sort(
    (left, right) => left.start - right.start || right.end - left.end
  );
  const collapsed: RedactionSpan[] = [];

  for (const span of sortedSpans) {
    const previous = collapsed.at(-1);

    if (!previous || span.start >= previous.end) {
      collapsed.push(span);
      continue;
    }

    if (previous.label === span.label) {
      previous.end = Math.max(previous.end, span.end);
      const combined = trimSpanOffsets(sourceText, previous.start, previous.end);
      previous.start = combined.start;
      previous.end = combined.end;
      previous.text = combined.text;
      previous.score = Math.max(previous.score, span.score);
      continue;
    }

    const preferCurrent =
      span.score > previous.score ||
      (span.score === previous.score &&
        span.end - span.start > previous.end - previous.start);

    if (preferCurrent) {
      collapsed[collapsed.length - 1] = span;
    }
  }

  return collapsed;
}

function parseEntityLabel(entity: string): {
  prefix: 'B' | 'I' | null;
  label: string | null;
} {
  const [prefix, rawLabel] = entity.includes('-')
    ? (entity.split('-', 2) as [string, string])
    : [null, entity];
  const normalizedLabel = normalizeEntityLabel(rawLabel);

  return {
    prefix: prefix === 'B' || prefix === 'I' ? prefix : null,
    label: normalizedLabel
  };
}

function normalizeEntityLabel(label: string | null): string | null {
  switch (label) {
    case 'PER':
      return 'PERSON';
    case 'ORG':
      return 'ORG';
    case 'LOC':
      return 'LOCATION';
    case 'MISC':
      return 'MISC';
    default:
      return label;
  }
}

function toAlphabeticSuffix(index: number): string {
  let current = index;
  let suffix = '';

  do {
    suffix = String.fromCharCode(65 + (current % 26)) + suffix;
    current = Math.floor(current / 26) - 1;
  } while (current >= 0);

  return suffix;
}

function postProgress(progress: ProgressInfo, requestId?: string): void {
  const total =
    'total' in progress && typeof progress.total === 'number'
      ? progress.total
      : undefined;
  const loaded =
    'loaded' in progress && typeof progress.loaded === 'number'
      ? progress.loaded
      : undefined;

  postStatus({
    requestId,
    stage: 'progress',
    message:
      'file' in progress && typeof progress.file === 'string'
        ? `Loading ${progress.file}`
        : `Redaction model progress: ${progress.status}`,
    progress:
      total && loaded !== undefined && total > 0 ? loaded / total : undefined
  });
}

function postStatus({
  requestId,
  stage,
  message,
  progress
}: Omit<WorkerStatusMessage, 'type' | 'model' | 'device'>): void {
  const response: WorkerStatusMessage = {
    type: 'status',
    requestId,
    stage,
    message,
    progress,
    model: MODEL_NAME,
    device: activeDevice
  };

  workerScope.postMessage(response satisfies NERWorkerResponse);
}

function postError(message: string, request?: Partial<NERWorkerRequest>): void {
  const response: WorkerErrorMessage = {
    type: 'error',
    requestId: request?.requestId,
    message
  };

  workerScope.postMessage(response satisfies NERWorkerResponse);
}

export {};
