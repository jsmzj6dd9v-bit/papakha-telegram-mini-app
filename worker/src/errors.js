export class ApiError extends Error {
  constructor(status, code, message = code, details = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const assert = (condition, status, code, message = code, details = null) => {
  if (!condition) throw new ApiError(status, code, message, details);
};
