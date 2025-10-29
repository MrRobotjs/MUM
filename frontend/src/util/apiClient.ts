const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

export type ApiFetchOptions = {
  csrfUrl?: string;
};

export type ParsedJson<T = unknown> = {
  data?: T;
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
  meta?: Record<string, unknown>;
} | T;

export class ApiError extends Error {
  status: number;
  details?: Record<string, unknown>;
  payload?: ParsedJson;

  constructor(message: string, status: number, payload?: ParsedJson) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
    if (payload && typeof payload === 'object' && 'error' in payload && payload.error?.details) {
      this.details = payload.error.details;
    }
  }
}

let csrfToken: string | null = null;
let inflightCsrf: Promise<string | null> | null = null;

export const setCsrfToken = (token: string | null) => {
  csrfToken = token || null;
};

export const clearCsrfToken = () => {
  csrfToken = null;
};

const fetchCsrfToken = async (csrfUrl: string) => {
  const response = await fetch(csrfUrl, {
    credentials: 'include',
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    clearCsrfToken();
    throw new ApiError('Unable to obtain CSRF token', response.status);
  }

  try {
    const json = (await response.json()) as ParsedJson<{ csrf_token?: string }>;
    const token =
      (typeof json === 'object' && json && 'data' in json && (json.data as Record<string, unknown>)?.csrf_token) || null;
    csrfToken = typeof token === 'string' ? token : null;
    return csrfToken;
  } catch (error) {
    clearCsrfToken();
    throw error;
  }
};

export const ensureCsrfToken = async (csrfUrl = '/admin/api/v2/auth/csrf-token') => {
  if (csrfToken) {
    return csrfToken;
  }

  if (!inflightCsrf) {
    inflightCsrf = fetchCsrfToken(csrfUrl).finally(() => {
      inflightCsrf = null;
    });
  }

  return inflightCsrf;
};

const getJson = async (response: Response): Promise<ParsedJson | null> => {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export const apiFetch = async (
  input: RequestInfo,
  init: RequestInit = {},
  options: ApiFetchOptions = {}
): Promise<Response> => {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers ?? {});

  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }

  const body = init.body;
  if (body && !(body instanceof FormData) && !headers.has('Content-Type')) {
    if (typeof body === 'string') {
      headers.set('Content-Type', 'application/json');
    }
  }

  if (!SAFE_METHODS.has(method)) {
    if (!csrfToken) {
      await ensureCsrfToken(options.csrfUrl);
    }
    if (csrfToken) {
      headers.set('X-CSRF-Token', csrfToken);
    }
  }

  const response = await fetch(input, {
    ...init,
    method,
    credentials: 'include',
    headers
  });

  if (response.status === 401) {
    clearCsrfToken();
  }

  return response;
};

export const requestJson = async <T = ParsedJson>(
  input: RequestInfo,
  init: RequestInit = {},
  options: ApiFetchOptions = {}
): Promise<T> => {
  const response = await apiFetch(input, init, options);
  const json = await getJson(response);

  if (!response.ok) {
    const errorPayload = (json ?? undefined) as ParsedJson | undefined;
    const message =
      (typeof errorPayload === 'object' &&
        errorPayload &&
        'error' in errorPayload &&
        errorPayload.error?.message) ||
      response.statusText ||
      'Request failed';
    throw new ApiError(message, response.status, errorPayload);
  }

  return (json as T) ?? ({} as T);
};
