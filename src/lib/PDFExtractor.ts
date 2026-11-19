import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

export interface PDFTextItem {
  str: string;
  transform: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
}

export interface ExtractedPDFPage {
  pageNumber: number;
  text: string;
}

export interface PDFExtractionResult {
  fileName: string;
  pageCount: number;
  pages: ExtractedPDFPage[];
  fullText: string;
}

type PDFDocumentProxy = Awaited<
  ReturnType<typeof pdfjsLib.getDocument>['promise']
>;
type PDFPageProxy = Awaited<ReturnType<PDFDocumentProxy['getPage']>>;

export class PDFExtractor {
  static async extract(file: File): Promise<PDFExtractionResult> {
    if (
      file.type !== 'application/pdf' &&
      !file.name.toLowerCase().endsWith('.pdf')
    ) {
      throw new Error('PDFExtractor only accepts PDF files.');
    }

    const arrayBuffer = await this.readFileAsArrayBuffer(file);
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),
      useWorkerFetch: false,
      isEvalSupported: false,
      stopAtErrors: true
    });
    const pdf = await loadingTask.promise;

    try {
      const pages: ExtractedPDFPage[] = [];

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const text = await this.extractPageText(page);
        pages.push({
          pageNumber,
          text
        });
        page.cleanup();
      }

      return {
        fileName: file.name,
        pageCount: pdf.numPages,
        pages,
        fullText: pages.map((page) => page.text).join('\n\n')
      };
    } finally {
      await pdf.destroy();
    }
  }

  static extractTextFromItems(items: unknown[]): string {
    let result = '';
    let prevItem: PDFTextItem | null = null;
    let pendingEOL = false;

    for (const rawItem of items) {
      if (!this.isTextItem(rawItem)) {
        continue;
      }

      const item = rawItem;
      const str = item.str;

      if (!str) {
        if (item.hasEOL) {
          pendingEOL = true;
        }
        continue;
      }

      if (prevItem) {
        const prevX = prevItem.transform[4] ?? 0;
        const prevY = prevItem.transform[5] ?? 0;
        const prevWidth = prevItem.width ?? 0;
        const currX = item.transform[4] ?? 0;
        const currY = item.transform[5] ?? 0;

        const isLineBreak =
          pendingEOL ||
          prevItem.hasEOL === true ||
          Math.abs(currY - prevY) > 2;

        if (isLineBreak) {
          if (!result.endsWith('\n')) {
            result += '\n';
          }
        } else {
          // On the same line: Math.abs(currY - prevY) <= 2
          const horizontalGap = prevWidth > 0 ? currX - (prevX + prevWidth) : currX - prevX;
          const isPunctuation = /^[,.;:!?%)\]}]/.test(str);
          const isOpenBracket = /[([/{-]$/.test(result);
          const alreadyHasSpace =
            result.endsWith(' ') ||
            result.endsWith('\n') ||
            str.startsWith(' ');

          const hasGap = prevWidth > 0 ? horizontalGap > 1.5 : Math.abs(currX - prevX) > 3;

          if (!alreadyHasSpace && !isPunctuation && !isOpenBracket && hasGap) {
            result += ' ';
          }
        }
      }

      result += str;
      prevItem = item;
      pendingEOL = item.hasEOL === true;
    }

    // Normalize excessive horizontal whitespace without collapsing newlines
    return result
      .split('\n')
      .map((line) => line.replace(/[^\S\r\n]+/g, ' ').trim())
      .filter((line, index, arr) => {
        if (line.length === 0) {
          return index > 0 && arr[index - 1].length > 0;
        }
        return true;
      })
      .join('\n')
      .trim();
  }

  private static async extractPageText(page: PDFPageProxy): Promise<string> {
    const textContent = await page.getTextContent();
    return this.extractTextFromItems(textContent.items);
  }

  private static isTextItem(item: unknown): item is PDFTextItem {
    return (
      typeof item === 'object' &&
      item !== null &&
      'str' in item &&
      typeof (item as { str: unknown }).str === 'string' &&
      'transform' in item &&
      Array.isArray((item as { transform: unknown }).transform)
    );
  }

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
