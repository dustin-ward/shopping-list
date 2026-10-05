import { json } from '@sveltejs/kit';
import { z, type ZodType } from 'zod';

export class AppError extends Error {
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
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.fieldErrors = options.fieldErrors;
    this.details = options.details;
  }
}

export function badRequest(code: string, message: string): AppError {
  return new AppError(400, code, message);
}

export function notFound(message: string): AppError {
  return new AppError(404, 'NOT_FOUND', message);
}

export function conflict(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): AppError {
  return new AppError(409, code, message, { details });
}

export function jsonNoStore(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('cache-control', 'no-store');
  return json(data, { ...init, headers });
}

export async function parseJson<TSchema extends ZodType>(
  request: Request,
  schema: TSchema,
): Promise<z.infer<TSchema>> {
  const contentType = request.headers
    .get('content-type')
    ?.split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    throw new AppError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Send this request as JSON.',
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw badRequest('INVALID_JSON', 'The request body is not valid JSON.');
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const field = issue.path.map(String).join('.') || '_';
      (fieldErrors[field] ??= []).push(issue.message);
    }
    throw new AppError(400, 'VALIDATION_ERROR', 'Check the submitted fields.', {
      fieldErrors,
    });
  }

  return result.data;
}

export function apiErrorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    return jsonNoStore(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
          ...(error.details ? { details: error.details } : {}),
        },
      },
      { status: error.status },
    );
  }

  console.error('Unexpected API failure:', error);
  return jsonNoStore(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong. Please try again.',
      },
    },
    { status: 500 },
  );
}
