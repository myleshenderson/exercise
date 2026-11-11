/** Raised for any FIT or ZIP input the decoder cannot read safely. */
export class FitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FitError";
  }
}
