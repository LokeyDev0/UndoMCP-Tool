import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

export interface HttpUpstreamConfig {
  url: string;
  transport: 'http' | 'streamable-http' | 'sse' | 'ws';
  defaultHeaders?: Record<string, string>;
}

export interface ForwardResult {
  status: number;
  headers: Record<string, string>;
  body: any;
  isStream: boolean;
  rawResponse?: http.IncomingMessage;
}

export class HttpUpstreamClient {
  private url: URL;
  private transport: string;
  private defaultHeaders: Record<string, string>;

  constructor(config: HttpUpstreamConfig) {
    this.url = new URL(config.url);
    this.transport = config.transport;
    this.defaultHeaders = config.defaultHeaders || {};
  }

  public async forwardRequest(
    body: any,
    incomingHeaders: Record<string, string>,
    method: string = 'POST'
  ): Promise<ForwardResult> {
    const mergedHeaders: Record<string, string> = {
      ...this.defaultHeaders,
      ...incomingHeaders,
      'host': this.url.host,
    };

    // Remove hop-by-hop headers
    delete mergedHeaders['connection'];
    delete mergedHeaders['keep-alive'];
    delete mergedHeaders['transfer-encoding'];

    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);

    if (method === 'POST') {
      mergedHeaders['content-length'] = String(Buffer.byteLength(bodyStr, 'utf8'));
      if (!mergedHeaders['content-type']) {
        mergedHeaders['content-type'] = 'application/json';
      }
    }

    const client = this.url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const req = client.request(
        {
          hostname: this.url.hostname,
          port: this.url.port || (this.url.protocol === 'https:' ? 443 : 80),
          path: this.url.pathname + this.url.search,
          method,
          headers: mergedHeaders,
        },
        (res) => {
          const contentType = res.headers['content-type'] || '';
          const isStream = contentType.includes('text/event-stream');

          if (isStream) {
            resolve({
              status: res.statusCode || 200,
              headers: this.flattenHeaders(res.headers),
              body: null,
              isStream: true,
              rawResponse: res,
            });
            return;
          }

          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed: any = raw;
            try {
              parsed = JSON.parse(raw);
            } catch {
              // Keep as string if not JSON
            }
            resolve({
              status: res.statusCode || 200,
              headers: this.flattenHeaders(res.headers),
              body: parsed,
              isStream: false,
            });
          });
          res.on('error', reject);
        }
      );

      req.on('error', reject);
      req.setTimeout(120000, () => {
        req.destroy(new Error('Upstream request timed out after 120s'));
      });

      if (method === 'POST') {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  public async forwardSSEConnect(
    incomingHeaders: Record<string, string>
  ): Promise<http.IncomingMessage> {
    const mergedHeaders: Record<string, string> = {
      ...this.defaultHeaders,
      ...incomingHeaders,
      'host': this.url.host,
      'accept': 'text/event-stream',
      'cache-control': 'no-cache',
    };

    delete mergedHeaders['connection'];
    delete mergedHeaders['keep-alive'];

    const client = this.url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const req = client.request(
        {
          hostname: this.url.hostname,
          port: this.url.port || (this.url.protocol === 'https:' ? 443 : 80),
          path: this.url.pathname + this.url.search,
          method: 'GET',
          headers: mergedHeaders,
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`SSE upstream returned ${res.statusCode}`));
            return;
          }
          resolve(res);
        }
      );

      req.on('error', reject);
      req.end();
    });
  }

  public getUrl(): string {
    return this.url.toString();
  }

  public close(): void {
    // No persistent connections to close for HTTP transport
    // SSE/WS connections would be closed here if maintained
  }

  private flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (value) {
        flat[key] = Array.isArray(value) ? value.join(', ') : value;
      }
    }
    return flat;
  }
}
