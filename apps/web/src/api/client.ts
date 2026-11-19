import { EmulatorApiClient } from '@droidforge/shared';

export function getApiKey(): string {
  return localStorage.getItem('droidforge_api_key') ?? '';
}

export function setApiKey(key: string): void {
  localStorage.setItem('droidforge_api_key', key);
}

export function createClient(): EmulatorApiClient {
  return new EmulatorApiClient({
    baseUrl: '',
    apiKey: getApiKey() || undefined,
  });
}

export function buildWsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const key = getApiKey();
  const sep = path.includes('?') ? '&' : '?';
  const authQuery = key ? `${sep}apiKey=${encodeURIComponent(key)}` : '';
  return `${proto}//${window.location.host}${path}${authQuery}`;
}
