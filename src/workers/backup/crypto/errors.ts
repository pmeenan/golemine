export type BackupCryptoErrorCode =
  | "malformed-keybag"
  | "unsupported-keybag"
  | "wrong-password"
  | "malformed-key-material"
  | "key-unwrap-failed"
  | "malformed-ciphertext"
  | "decryption-failed";

/**
 * A deliberately small, provider-internal error taxonomy. Callers can map the
 * code to worker/UI errors without exposing passwords, key bytes, or WebCrypto
 * implementation details in messages.
 */
export class BackupCryptoError extends Error {
  readonly code: BackupCryptoErrorCode;

  constructor(
    code: BackupCryptoErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BackupCryptoError";
    this.code = code;
  }
}

export function isBackupCryptoError(
  value: unknown,
): value is BackupCryptoError {
  return value instanceof BackupCryptoError;
}

