export interface AssetPutInput {
  assetId: Uint8Array;
  version: number;
  bytes: Uint8Array;
  mime?: string;
}

export interface AssetGetResult {
  bytes: Buffer;
}

export interface AssetBackend {
  readonly scheme: string;
  put(input: AssetPutInput): Promise<string>;
  get(storageRef: string): Promise<AssetGetResult>;
  delete(storageRef: string): Promise<void>;
}

export class AssetBackendRegistry {
  private readonly backends = new Map<string, AssetBackend>();
  private defaultName: string | null = null;

  register(backend: AssetBackend, opts?: { asDefault?: boolean }): void {
    this.backends.set(backend.scheme, backend);
    if (opts?.asDefault === true || this.defaultName === null) {
      this.defaultName = backend.scheme;
    }
  }

  setDefault(scheme: string): void {
    if (!this.backends.has(scheme)) {
      throw new Error(`No asset backend registered for scheme "${scheme}"`);
    }
    this.defaultName = scheme;
  }

  default(): AssetBackend {
    if (this.defaultName === null) {
      throw new Error('No asset backend registered');
    }
    const b = this.backends.get(this.defaultName);
    if (!b) throw new Error(`Default asset backend "${this.defaultName}" missing`);
    return b;
  }

  resolve(storageRef: string): AssetBackend {
    const scheme = storageRef.split(':')[0] ?? '';
    const b = this.backends.get(scheme);
    if (!b) {
      throw new Error(
        `No asset backend registered for scheme "${scheme}" (storage_ref: ${storageRef})`
      );
    }
    return b;
  }
}
