/** §3.4 of the UI service contract. Never dump `{ "error": … }` or paths. */

export interface ServiceErrorCopy {
  title: string;
  detail: string;
  tone: 'danger' | 'neutral';
}

export const SERVICE_ERROR_COPY: Record<400 | 401 | 403 | 404 | 409 | 429 | 500, ServiceErrorCopy> = {
  400: {
    title: 'That request was not accepted',
    detail: 'A security-relevant field was malformed or unknown.',
    tone: 'danger',
  },
  401: {
    title: 'Authentication failed',
    detail: 'Missing, guessed, expired, or claimed credentials all look the same.',
    tone: 'danger',
  },
  403: {
    title: 'Not allowed',
    detail: 'This tab is signed in but cannot do that from here.',
    tone: 'danger',
  },
  404: {
    title: 'Not available',
    detail: 'Unknown, deleted, or unauthorized. Those cases are not distinguished.',
    tone: 'danger',
  },
  409: {
    title: 'That change conflicts',
    detail: 'Do not create a second principal. Another request already won.',
    tone: 'danger',
  },
  429: {
    title: 'Slow down',
    detail: 'Wait, then try again. Do not mint another scratch in a tight loop.',
    tone: 'neutral',
  },
  500: {
    title: 'Something went wrong',
    detail: 'Try again in a moment.',
    tone: 'danger',
  },
};

export function copyForHttpStatus(status: number): ServiceErrorCopy {
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 409 || status === 429) {
    return SERVICE_ERROR_COPY[status];
  }
  return SERVICE_ERROR_COPY[500];
}

export class ServiceError extends Error {
  readonly status: number;
  readonly copy: ServiceErrorCopy;

  constructor(status: number) {
    const copy = copyForHttpStatus(status);
    super(copy.title);
    this.name = 'ServiceError';
    this.status = status;
    this.copy = copy;
  }
}

export function copyForUnknownFailure(): ServiceErrorCopy {
  return SERVICE_ERROR_COPY[500];
}
