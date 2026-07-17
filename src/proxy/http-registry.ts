import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface HttpUpstreamEntry {
  url: string;
  transport: 'http' | 'streamable-http' | 'sse' | 'ws';
  projectDir?: string;
}

export interface HttpRegistryData {
  port: number;
  upstreams: Record<string, HttpUpstreamEntry>;
}

const DEFAULT_PORT = 19750;

export class HttpRegistry {
  private filePath: string;
  private data: HttpRegistryData;

  constructor(filePath?: string) {
    this.filePath = filePath || path.join(os.homedir(), '.undomcp', 'http-registry.json');
    this.data = this.load();
  }

  private load(): HttpRegistryData {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf8');
        return JSON.parse(content);
      }
    } catch {
      // Corrupted file, start fresh
    }
    return { port: DEFAULT_PORT, upstreams: {} };
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  public register(namespace: string, entry: HttpUpstreamEntry): void {
    this.data.upstreams[namespace] = entry;
    this.save();
  }

  public unregister(namespace: string): void {
    delete this.data.upstreams[namespace];
    this.save();
  }

  public lookup(namespace: string): HttpUpstreamEntry | undefined {
    return this.data.upstreams[namespace];
  }

  public listAll(): Record<string, HttpUpstreamEntry> {
    return { ...this.data.upstreams };
  }

  public getPort(): number {
    return this.data.port || DEFAULT_PORT;
  }

  public setPort(port: number): void {
    this.data.port = port;
    this.save();
  }

  public buildLocalUrl(namespace: string): string {
    return `http://127.0.0.1:${this.getPort()}/proxy/${namespace}/`;
  }
}
