type ApiFailureBody = {
  error?: {
    code?: string;
    message?: string;
    fieldErrors?: Record<string, string[]>;
    details?: Record<string, unknown>;
  };
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors?: Record<string, string[]>;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    options: {
      fieldErrors?: Record<string, string[]>;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fieldErrors = options.fieldErrors;
    this.details = options.details;
  }
}

export async function requestJson<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers = new Headers();
  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.body);
  }

  const response = await fetch(path, {
    method: options.method ?? 'GET',
    body,
    headers,
    cache: 'no-store',
  });
  if (!response.ok) {
    const failure = (await response
      .json()
      .catch(() => null)) as ApiFailureBody | null;
    throw new ApiError(
      response.status,
      failure?.error?.code ?? 'REQUEST_FAILED',
      failure?.error?.message ?? 'The request could not be completed.',
      {
        fieldErrors: failure?.error?.fieldErrors,
        details: failure?.error?.details,
      },
    );
  }
  return (await response.json()) as T;
}
