/** A provider isn't configured on the server (missing env). Never retried. */
export class ProviderNotConfiguredError extends Error {
  constructor(public readonly capability: string, public readonly missing: string[]) {
    super(`${capability}: no provider configured${missing.length ? ` (missing ${missing.join(', ')})` : ''}`)
    this.name = 'ProviderNotConfiguredError'
  }
}

/** The model declined (safety). Not retried; surfaced to the human. */
export class ProviderRefusalError extends Error {
  constructor(public readonly provider: string, public readonly detail?: string) {
    super(`${provider} declined the request${detail ? `: ${detail}` : ''}`)
    this.name = 'ProviderRefusalError'
  }
}

/** Transport/API failure. `retryable` drives agent/job retry decisions. */
export class ProviderError extends Error {
  constructor(message: string, public readonly retryable: boolean, public readonly status?: number) {
    super(message)
    this.name = 'ProviderError'
  }
}

/** Output didn't match the requested schema. */
export class ProviderOutputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderOutputError'
  }
}

export function isRetryable(e: unknown): boolean {
  return e instanceof ProviderError && e.retryable
}

export function retryableStatus(status: number | undefined): boolean {
  return status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500)
}
