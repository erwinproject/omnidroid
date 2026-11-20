import type {
  AiSnapshotResponse,
  BatteryInput,
  CloneInstanceInput,
  CreateDeviceProfileInput,
  CreateInstanceInput,
  CreateProxyProfileInput,
  DeleteInstanceResult,
  DeleteSnapshotResult,
  DeviceProfile,
  GeneratedIdentity,
  GestureInput,
  ImportProxiesInput,
  InstanceHealth,
  InstanceProxyState,
  InstanceProxyVerifyResult,
  InstanceRecord,
  LocationInput,
  NetworkInput,
  ProxyProfile,
  ProxyTestResult,
  PruneOptionsInput,
  PruneReport,
  RotationInput,
  RootStatusResponse,
  SetInstanceProxyInput,
  ShellCommandInput,
  SnapshotRecord,
  StealthCheckReport,
  SwipeInput,
  SystemImageStatus,
  TapInput,
  TestProxyInput,
  TextInput,
  UpdateInstanceInput,
  UpdateRootConfigInput,
  UiBatchActionsInput,
  UiClickInput,
  UiNode,
  UiSelector,
  UiWaitInput,
} from '../index.js';

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
}

export class EmulatorApiClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(this.apiKey ? { 'X-API-Key': this.apiKey } : {}),
      ...((init?.headers as Record<string, string>) ?? {}),
    };

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API Error ${res.status} (${path}): ${text}`);
    }

    if (res.status === 204) {
      return undefined as T;
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return (await res.json()) as T;
    }
    return (await res.text()) as unknown as T;
  }

  readonly profiles = {
    list: () => this.request<DeviceProfile[]>('/api/v1/profiles'),
    get: (id: string) => this.request<DeviceProfile>(`/api/v1/profiles/${encodeURIComponent(id)}`),
    create: (input: CreateDeviceProfileInput) =>
      this.request<DeviceProfile>('/api/v1/profiles', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    update: (id: string, input: CreateDeviceProfileInput) =>
      this.request<DeviceProfile>(`/api/v1/profiles/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    delete: (id: string) =>
      this.request<{ deleted: boolean }>(`/api/v1/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    generateIdentity: (macOui?: string) =>
      this.request<GeneratedIdentity>('/api/v1/profiles/generate-identity', {
        method: 'POST',
        body: JSON.stringify({ macOui }),
      }),
  };

  readonly instances = {
    list: () => this.request<InstanceRecord[]>('/api/v1/instances'),
    get: (id: string) => this.request<InstanceRecord>(`/api/v1/instances/${id}`),
    create: (input: CreateInstanceInput) =>
      this.request<InstanceRecord>('/api/v1/instances', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    update: (id: string, input: UpdateInstanceInput) =>
      this.request<InstanceRecord>(`/api/v1/instances/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    start: (id: string) =>
      this.request<InstanceRecord>(`/api/v1/instances/${id}/start`, { method: 'POST' }),
    stop: (id: string) =>
      this.request<InstanceRecord>(`/api/v1/instances/${id}/stop`, { method: 'POST' }),
    restart: (id: string) =>
      this.request<InstanceRecord>(`/api/v1/instances/${id}/restart`, { method: 'POST' }),
    delete: (id: string, removeVolume = true, prune = true) =>
      this.request<DeleteInstanceResult>(
        `/api/v1/instances/${id}?removeVolume=${String(removeVolume)}&prune=${String(prune)}`,
        { method: 'DELETE' },
      ),
    health: (id: string) => this.request<InstanceHealth>(`/api/v1/instances/${id}/health`),
    clone: (id: string, input: CloneInstanceInput) =>
      this.request<InstanceRecord>(`/api/v1/instances/${id}/clone`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    listSnapshots: (id: string) =>
      this.request<SnapshotRecord[]>(`/api/v1/instances/${id}/snapshots`),
    createSnapshot: (id: string, name?: string) =>
      this.request<SnapshotRecord>(`/api/v1/instances/${id}/snapshots`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    restoreSnapshot: (id: string, snapId: string) =>
      this.request<{ restored: boolean }>(`/api/v1/instances/${id}/snapshots/${snapId}/restore`, {
        method: 'POST',
      }),
    deleteSnapshot: (id: string, snapId: string) =>
      this.request<DeleteSnapshotResult>(`/api/v1/instances/${id}/snapshots/${snapId}`, {
        method: 'DELETE',
      }),
    getProxy: (id: string) =>
      this.request<InstanceProxyState>(`/api/v1/instances/${id}/proxy`),
    setProxy: (id: string, input: SetInstanceProxyInput) =>
      this.request<InstanceProxyState>(`/api/v1/instances/${id}/proxy`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    clearProxy: (id: string) =>
      this.request<InstanceProxyState>(`/api/v1/instances/${id}/proxy`, {
        method: 'DELETE',
      }),
    verifyProxy: (id: string) =>
      this.request<InstanceProxyVerifyResult>(`/api/v1/instances/${id}/proxy/verify`, {
        method: 'POST',
      }),
  };

  readonly proxies = {
    list: () => this.request<ProxyProfile[]>('/api/v1/proxies'),
    create: (input: CreateProxyProfileInput) =>
      this.request<ProxyProfile>('/api/v1/proxies', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    import: (input: ImportProxiesInput) =>
      this.request<{ imported: ProxyProfile[]; failed: Array<{ line: string; error: string }> }>(
        '/api/v1/proxies/import',
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      ),
    delete: (id: string) =>
      this.request<{ deleted: boolean }>(`/api/v1/proxies/${id}`, { method: 'DELETE' }),
    test: (input: TestProxyInput) =>
      this.request<ProxyTestResult>('/api/v1/proxies/test', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    testById: (id: string) =>
      this.request<ProxyTestResult>(`/api/v1/proxies/${id}/test`, { method: 'POST' }),
  };

  readonly system = {
    images: () => this.request<SystemImageStatus[]>('/api/v1/system/images'),
    prunePreview: (options?: {
      includeUnusedImages?: boolean;
      includeBuildCache?: boolean;
      minTempFileAgeMs?: number;
    }) => {
      const params = new URLSearchParams();
      if (options?.includeUnusedImages !== undefined) {
        params.set('includeUnusedImages', String(options.includeUnusedImages));
      }
      if (options?.includeBuildCache !== undefined) {
        params.set('includeBuildCache', String(options.includeBuildCache));
      }
      if (options?.minTempFileAgeMs !== undefined) {
        params.set('minTempFileAgeMs', String(options.minTempFileAgeMs));
      }
      const qs = params.toString();
      return this.request<PruneReport>(`/api/v1/system/prune/preview${qs ? `?${qs}` : ''}`);
    },
    prune: (options?: PruneOptionsInput) =>
      this.request<PruneReport>('/api/v1/system/prune', {
        method: 'POST',
        body: JSON.stringify(options ?? {}),
      }),
    streamCheck: (instanceId: string) =>
      this.request<{
        jarPresent: boolean;
        adbForwardSupported: boolean;
        started: boolean;
        firstFrameMs: number | null;
        width: number | null;
        height: number | null;
        error: string | null;
      }>(`/api/v1/system/stream-check?instanceId=${encodeURIComponent(instanceId)}`),
  };

  readonly files = {
    list: (id: string, remotePath = '/sdcard') =>
      this.request<{
        path: string;
        entries: Array<{ name: string; isDir: boolean; size: number; permissions: string; modified: string }>;
      }>(`/api/v1/instances/${id}/files/list?path=${encodeURIComponent(remotePath)}`),
    mkdir: (id: string, remotePath: string) =>
      this.request<{ ok: boolean; path: string }>(`/api/v1/instances/${id}/files/mkdir`, {
        method: 'POST',
        body: JSON.stringify({ path: remotePath }),
      }),
    delete: (id: string, remotePath: string) =>
      this.request<{ deleted: boolean; path: string }>(
        `/api/v1/instances/${id}/files?path=${encodeURIComponent(remotePath)}`,
        { method: 'DELETE' },
      ),
  };

  readonly input = {
    tap: (id: string, input: TapInput) =>
      this.request<{ ok: boolean }>(`/api/v1/instances/${id}/input/tap`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    swipe: (id: string, input: SwipeInput) =>
      this.request<{ ok: boolean }>(`/api/v1/instances/${id}/input/swipe`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    text: (id: string, input: TextInput) =>
      this.request<{ ok: boolean }>(`/api/v1/instances/${id}/input/text`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    keyevent: (id: string, key: string | number) =>
      this.request<{ ok: boolean }>(`/api/v1/instances/${id}/input/keyevent`, {
        method: 'POST',
        body: JSON.stringify({ key }),
      }),
    gesture: (id: string, input: GestureInput) =>
      this.request<{ ok: boolean; executedSteps: number }>(`/api/v1/instances/${id}/input/gesture`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  };

  readonly ui = {
    hierarchy: (id: string) =>
      this.request<{ xml: string; tree: UiNode[] }>(`/api/v1/instances/${id}/ui/hierarchy`),
    aiSnapshot: (id: string) =>
      this.request<AiSnapshotResponse>(`/api/v1/instances/${id}/ui/ai-snapshot`),
    find: (id: string, selector: UiSelector) =>
      this.request<{ count: number; nodes: UiNode[] }>(`/api/v1/instances/${id}/ui/find`, {
        method: 'POST',
        body: JSON.stringify(selector),
      }),
    click: (id: string, input: UiClickInput) =>
      this.request<{ ok: boolean; clicked: { x: number; y: number } }>(
        `/api/v1/instances/${id}/ui/click`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      ),
    wait: (id: string, input: UiWaitInput) =>
      this.request<{ matched: boolean; elapsedMs: number }>(`/api/v1/instances/${id}/ui/wait`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    batch: (id: string, input: UiBatchActionsInput) =>
      this.request<{ ok: boolean; results: unknown[]; finalScreenshotBase64?: string }>(
        `/api/v1/instances/${id}/ui/actions/batch`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      ),
  };

  readonly device = {
    info: (id: string) => this.request<Record<string, unknown>>(`/api/v1/instances/${id}/device/info`),
    shell: (id: string, input: ShellCommandInput) =>
      this.request<{ exitCode: number; stdout: string; stderr: string }>(
        `/api/v1/instances/${id}/device/shell`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      ),
    location: (id: string, input: LocationInput) =>
      this.request<{ ok: boolean }>(`/api/v1/instances/${id}/device/location`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    battery: (id: string, input: BatteryInput) =>
      this.request<{ ok: boolean }>(`/api/v1/instances/${id}/device/battery`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    network: (id: string, input: NetworkInput) =>
      this.request<{ ok: boolean }>(`/api/v1/instances/${id}/device/network`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    rotation: (id: string, input: RotationInput) =>
      this.request<{ ok: boolean }>(`/api/v1/instances/${id}/device/rotation`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    stealthCheck: (id: string) =>
      this.request<StealthCheckReport>(`/api/v1/instances/${id}/device/stealth-check`),
    getRoot: (id: string) =>
      this.request<RootStatusResponse>(`/api/v1/instances/${id}/device/root`),
    setRoot: (id: string, input: UpdateRootConfigInput) =>
      this.request<RootStatusResponse>(`/api/v1/instances/${id}/device/root`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    grantRootApp: (id: string, packageName: string) =>
      this.request<RootStatusResponse>(`/api/v1/instances/${id}/device/root/apps`, {
        method: 'POST',
        body: JSON.stringify({ packageName }),
      }),
    revokeRootApp: (id: string, packageName: string) =>
      this.request<RootStatusResponse>(
        `/api/v1/instances/${id}/device/root/apps/${encodeURIComponent(packageName)}`,
        { method: 'DELETE' },
      ),
  };
}
