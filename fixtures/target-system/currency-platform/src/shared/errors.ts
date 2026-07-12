export class NotImplementedError extends Error {
  public constructor(symbol: string) {
    if (typeof symbol !== "string") throw new TypeError("not-implemented symbol must be text");
    const normalized = symbol.trim();
    if (!/^[A-Z][A-Za-z0-9]+\.[a-z][A-Za-z0-9]+$/u.test(normalized)) {
      throw new TypeError("not-implemented symbol must use ClassName.methodName format");
    }
    if (normalized.length > 120) throw new TypeError("not-implemented symbol exceeds length limit");
    super(`${normalized} is intentionally not implemented`);
    this.name = "NotImplementedError";
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends Error {
  public constructor(message: string) {
    if (typeof message !== "string") throw new TypeError("validation error message must be text");
    const normalized = message.trim();
    if (normalized.length === 0) throw new TypeError("validation error message cannot be blank");
    if (normalized.length > 4_096) throw new TypeError("validation error message exceeds length limit");
    super(normalized);
    this.name = "ValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace?.(this, new.target);
  }
}
