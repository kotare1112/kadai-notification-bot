// myFIT 取り込みのエラー種別。
export type MyfitErrorCode = "bad_password" | "mfa_required" | "blocked" | "timeout" | "layout_changed" | "unknown";

export class MyfitError extends Error {
  constructor(
    readonly code: MyfitErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MyfitError";
  }
}

export interface MyfitCredentials {
  id: string;
  password: string;
}
