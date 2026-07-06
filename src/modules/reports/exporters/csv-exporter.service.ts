import { Injectable } from '@nestjs/common';
import { Readable } from 'stream';

import { formatCellValue, inferHeaders, sanitizeFormula } from '../utils/format.utils';
import type { CsvOptions, ICsvExporter } from '../types/export.types';

/**
 * BE-21 — Lightweight CSV writer.
 *
 * RFC 4180 compliant for the subset we care about:
 *   - field separator     : `,` (configurable)
 *   - record separator    : `\r\n` (Excel-friendly)
 *   - quoting strategy    : every field that contains the separator,
 *                           a quote, CR, or LF is wrapped in double
 *                           quotes; embedded quotes are doubled.
 *
 * We intentionally do **not** depend on the `csv-stringify` package
 * (BE-21 spec listed it but it isn't currently installed). The body
 * of the spec only requires "standard CSV, UTF-8" and the streaming
 * variant — both are trivial to implement and easier to reason about
 * for tenant-isolated tests.
 *
 * **Formula injection**: every string value is sanitised with
 * `sanitizeFormula` before quoting. This neutralises the OWASP
 * CSV-injection vector at the writer layer instead of relying on the
 * caller.
 */
@Injectable()
export class CsvExporterService implements ICsvExporter {
  async generate(rows: Record<string, unknown>[], options: CsvOptions = {}): Promise<Buffer> {
    const lines: string[] = [];
    const opts = this.normalise(options);

    if (rows.length === 0) {
      return this.toBuffer('', opts);
    }

    const headers = inferHeaders(rows);
    if (opts.header && headers.length > 0) {
      lines.push(this.encodeRow(headers, opts));
    }

    for (const row of rows) {
      const values = headers.map((h) => row[h]);
      lines.push(this.encodeRow(values, opts));
    }

    return this.toBuffer(lines.join('\r\n') + '\r\n', opts);
  }

  /**
   * Streaming variant for very large datasets. The first row drives
   * header inference. Suitable for piping into S3 multipart uploads
   * or HTTP response bodies without buffering the whole file.
   */
  stream(
    rows: AsyncIterable<Record<string, unknown>>,
    options: CsvOptions = {},
  ): NodeJS.ReadableStream {
    const opts = this.normalise(options);
    const encodeRow = this.encodeRow.bind(this);
    const bom = opts.bom ? '\uFEFF' : '';

    async function* generator(): AsyncGenerator<Buffer> {
      let headers: string[] | null = null;
      let firstChunk = true;

      for await (const row of rows) {
        if (!headers) {
          headers = Object.keys(row);
          if (opts.header && headers.length > 0) {
            yield Buffer.from(
              (firstChunk ? bom : '') + encodeRow(headers, opts) + '\r\n',
              opts.encoding,
            );
            firstChunk = false;
          }
        }
        const prefix = firstChunk ? bom : '';
        const values = headers.map((h) => row[h]);
        yield Buffer.from(prefix + encodeRow(values, opts) + '\r\n', opts.encoding);
        firstChunk = false;
      }

      // Honour BOM-only output for empty streams when bom is requested.
      if (firstChunk && bom) {
        yield Buffer.from(bom, opts.encoding);
      }
    }

    return Readable.from(generator());
  }

  /* ─────────────────── internals ─────────────────── */

  private normalise(options: CsvOptions): Required<CsvOptions> {
    return {
      delimiter: options.delimiter ?? ',',
      quote: options.quote ?? '"',
      escape: options.escape ?? '"',
      header: options.header ?? true,
      encoding: options.encoding ?? 'utf8',
      bom: options.bom ?? false,
    };
  }

  private encodeRow(values: unknown[], opts: Required<CsvOptions>): string {
    return values.map((v) => this.encodeField(v, opts)).join(opts.delimiter);
  }

  private encodeField(value: unknown, opts: Required<CsvOptions>): string {
    const raw = formatCellValue(value);
    const safe = sanitizeFormula(raw);

    const mustQuote =
      safe.includes(opts.delimiter) ||
      safe.includes(opts.quote) ||
      safe.includes('\n') ||
      safe.includes('\r');

    if (!mustQuote) return safe;
    const escaped = safe.split(opts.quote).join(opts.escape + opts.quote);
    return `${opts.quote}${escaped}${opts.quote}`;
  }

  private toBuffer(body: string, opts: Required<CsvOptions>): Buffer {
    const prefix = opts.bom ? '\uFEFF' : '';
    return Buffer.from(prefix + body, opts.encoding);
  }
}
