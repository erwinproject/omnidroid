import { getApiKey } from '../api/client';

export interface UploadProgress {
  loaded: number;
  total: number;
}

/** Multipart upload with progress (fetch cannot report upload progress). */
export function uploadFiles<T = unknown>(
  url: string,
  files: File[],
  onProgress?: (p: UploadProgress) => void,
  fieldName = 'file',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const form = new FormData();
    for (const f of files) form.append(fieldName, f, f.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    const key = getApiKey();
    if (key) xhr.setRequestHeader('X-API-Key', key);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.({ loaded: e.loaded, total: e.total });
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as T);
      } else {
        const msg = (body as { error?: string } | null)?.error ?? `HTTP ${xhr.status}`;
        const err = new Error(msg) as Error & { body?: unknown };
        err.body = body;
        reject(err);
      }
    };
    xhr.send(form);
  });
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${n || 0} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
