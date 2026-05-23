import type { JobResult } from "./job";

/**
 * Sink abstraction for engine jobs: the HLS runner writes verified segment bytes
 * through here. There is deliberately one implementation today:
 * InMemorySink. Keeping this boundary lets HLS tests inject a
 * capturing sink without pretending a production streaming sink exists.
 *
 * write() is monotonic — callers append bytes in the order they
 * should appear in the final file. close() flushes and returns the
 * final job result. abort() releases any resources without committing.
 */
export interface JobSink {
  open(filename: string, expectedSize: number | null): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<JobResult>;
  abort(): Promise<void>;
}

/**
 * In-renderer-memory sink. Large outputs are refused before this path when
 * their manifest gives us enough size information; otherwise final save still
 * goes through the browser downloads API.
 */
export class InMemorySink implements JobSink {
  private parts: BlobPart[] = [];
  private filename = "";
  private mime: string;
  private bytes = 0;

  constructor(mime: string) {
    this.mime = mime;
  }

  async open(filename: string, _expectedSize?: number | null): Promise<void> {
    this.filename = filename;
    this.parts = [];
    this.bytes = 0;
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.parts.push(bytes as BlobPart);
    this.bytes += bytes.byteLength;
  }

  async close(): Promise<JobResult> {
    const blob = new Blob(this.parts, { type: this.mime });
    return {
      blobUrl: URL.createObjectURL(blob),
      filename: this.filename,
      checksum: "",
    };
  }

  async abort(): Promise<void> {
    this.parts = [];
    this.bytes = 0;
  }

  byteLength(): number { return this.bytes; }
}
