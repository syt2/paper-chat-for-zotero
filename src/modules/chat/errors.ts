export class SessionRunInvalidatedError extends Error {
  constructor() {
    super("Session run invalidated");
  }
}
