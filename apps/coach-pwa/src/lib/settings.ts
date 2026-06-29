export const LS_API_BASE = 'coach_api_base';
export const LS_TOKEN = 'coach_ingest_token';

export type CoachSettings = {
  apiBaseUrl: string;
  ingestToken: string;
};

export function loadSettings(): CoachSettings {
  return {
    apiBaseUrl: localStorage.getItem(LS_API_BASE)?.trim() ?? '',
    ingestToken: localStorage.getItem(LS_TOKEN)?.trim() ?? '',
  };
}

export function saveSettings(s: CoachSettings): void {
  localStorage.setItem(LS_API_BASE, s.apiBaseUrl.trim());
  localStorage.setItem(LS_TOKEN, s.ingestToken.trim());
}

export function apiUrl(path: string, settings: CoachSettings): string {
  const base = settings.apiBaseUrl.replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function authHeaders(settings: CoachSettings): HeadersInit {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (settings.ingestToken) {
    h.Authorization = `Bearer ${settings.ingestToken}`;
  }
  return h;
}
