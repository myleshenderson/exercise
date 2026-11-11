/** Errors of the Peloton adapter. */

/** The stored refresh token is revoked, rejected or missing: Myles must paste a new one (reseed). */
export class PelotonReconnectRequired extends Error {
  constructor(message = "Peloton reconnect required: paste a new refresh token and reseed") {
    super(message);
    this.name = "PelotonReconnectRequired";
  }
}

/** Another run rotated the refresh token first (lost compare-and-swap); this run makes no API call. */
export class PelotonConcurrentRefresh extends Error {
  constructor(message = "Peloton refresh token was rotated by a concurrent run") {
    super(message);
    this.name = "PelotonConcurrentRefresh";
  }
}

/** A Peloton or Auth0 response that was not 2xx (after retries for 429 and 5xx). */
export class PelotonHttpError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string, detail = "") {
    super(`Peloton ${path}: HTTP ${status}${detail ? ` ${detail}` : ""}`);
    this.name = "PelotonHttpError";
    this.status = status;
    this.path = path;
  }
}
