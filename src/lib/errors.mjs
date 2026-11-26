export const EXIT = Object.freeze({
  OK: 0,
  ARGUMENT: 2,
  PRINTER: 3,
  RENDER: 4,
  PRINT: 5,
  REJECTED: 6,
  DUPLICATE: 7,
});

export class CliError extends Error {
  constructor(exitCode, message, details = null) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function messageOf(error) {
  if (!error) return 'unknown error';
  return String(error.message || error);
}
