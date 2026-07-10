/* eslint-disable react-refresh/only-export-components */
// ^ Same convention as m3-shared.tsx: the password-form component and its
// lifecycle hook are one security-critical unit and deliberately live in a
// single module, at the cost of fast-refresh granularity.
import { type ReactNode, type RefObject, useMemo, useRef } from "react";

import { cn } from "../../lib/cn";

/**
 * The one persistence disclosure rendered beside every backup-password form
 * (Design.md §7, D-038). Routes may prepend context with `disclosureLeadIn`,
 * but the security-relevant sentences live only here.
 */
const backupPasswordDisclosure =
  "The password and decryption keys stay in worker memory and are never " +
  "stored. Decrypted database content and generated media previews remain in " +
  "local derived storage until Remove backup wipes all derived data.";

/**
 * Structural shape of the worker results a password dispatch resolves to.
 * Deliberately not imported from worker-types: the controller only needs to
 * recognize the retryable wrong-password code, and `WorkerResult` satisfies
 * this shape structurally.
 */
export interface BackupPasswordDispatchResult {
  ok: boolean;
}

function isIncorrectPasswordResult(
  result: BackupPasswordDispatchResult,
): boolean {
  if (result.ok) {
    return false;
  }

  const error = (result as { error?: unknown }).error;

  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "backup_password_incorrect"
  );
}

/**
 * Owns the security-critical lifecycle of an uncontrolled backup-password
 * field (AGENTS.md hard rules: passwords never enter React state, are cleared
 * immediately after dispatch, and are never logged or persisted).
 */
export interface BackupPasswordFormController {
  /** Clear the uncontrolled field on any pre- or post-dispatch failure path. */
  clear(): void;
  /** Focus the field immediately (e.g. empty submit, restored form). */
  focus(): void;
  /**
   * Focus the field on the next animation frame, after the caller's error or
   * locked state has rendered and re-enabled the input.
   */
  focusAfterFrame(): void;
  /** Attached to the input rendered by {@link BackupPasswordForm}. */
  inputRef: RefObject<HTMLInputElement | null>;
  /** True when the field is missing or empty. */
  isEmpty(): boolean;
  /**
   * Read the uncontrolled field and clear it synchronously — before any
   * await — then invoke `dispatch` with the credential so the worker RPC
   * receives it in the same synchronous call chain (Comlink structured-clones
   * it during the RPC call). When the settled result reports the retryable
   * `backup_password_incorrect` code, the cleared field is refocused on the
   * next frame so the wrong password stays retryable in place (Design.md §7).
   * Throws `emptyPasswordMessage` when the field is missing or empty.
   */
  submitWithPassword<TResult extends BackupPasswordDispatchResult>(
    dispatch: (password: string) => Promise<TResult>,
    options: { emptyPasswordMessage: string },
  ): Promise<TResult>;
}

export function useBackupPasswordForm(): BackupPasswordFormController {
  const inputRef = useRef<HTMLInputElement | null>(null);

  return useMemo<BackupPasswordFormController>(() => {
    const focus = () => {
      inputRef.current?.focus();
    };
    const focusAfterFrame = () => {
      requestAnimationFrame(() => inputRef.current?.focus());
    };

    return {
      clear() {
        const input = inputRef.current;

        if (input !== null) {
          input.value = "";
        }
      },
      focus,
      focusAfterFrame,
      inputRef,
      isEmpty() {
        const input = inputRef.current;

        return input === null || input.value.length === 0;
      },
      async submitWithPassword(dispatch, options) {
        const input = inputRef.current;

        if (input === null || input.value.length === 0) {
          throw new Error(options.emptyPasswordMessage);
        }

        // The password lives only in the uncontrolled DOM field until this
        // synchronous read; the field is cleared before dispatch runs so no
        // path — success, worker error, or a synchronous dispatch throw —
        // can leave the credential in the document.
        const password = input.value;

        input.value = "";

        const result = await dispatch(password);

        if (isIncorrectPasswordResult(result)) {
          focusAfterFrame();
        }

        return result;
      },
    };
  }, []);
}

/**
 * The shared backup-password form: labelled uncontrolled password input, a
 * verb-first submit action, and the single persistence disclosure (Design.md
 * §7, D-038). Empty submits refocus the field; routes provide dispatch
 * behavior through {@link useBackupPasswordForm} and `onSubmit`.
 */
export function BackupPasswordForm({
  actions,
  children,
  className,
  controller,
  disabled,
  disclosureLeadIn,
  errorDescriptionId,
  inputId,
  inputSize,
  invalid,
  layout,
  leading,
  onEmptySubmit,
  onSubmit,
  required = false,
}: {
  /** Submit button(s); rendered between the field and the disclosure. */
  actions: ReactNode;
  /** Route-specific status or error rows rendered after the disclosure. */
  children?: ReactNode;
  className?: string;
  controller: BackupPasswordFormController;
  disabled: boolean;
  /** Route-specific context prepended to the shared disclosure copy. */
  disclosureLeadIn?: string;
  /**
   * Id of a route-rendered error element appended to the input's
   * aria-describedby while `invalid` is set.
   */
  errorDescriptionId?: string;
  inputId: string;
  inputSize: "lg" | "md";
  invalid: boolean;
  layout: "inline" | "stacked";
  /** Optional decorative element before the field in the inline layout. */
  leading?: ReactNode;
  /** Route-specific side effect (e.g. an error status) on empty submit. */
  onEmptySubmit?: () => void;
  onSubmit: () => void;
  required?: boolean;
}) {
  const disclosureId = `${inputId}-disclosure`;
  const field = (
    <div className={layout === "inline" ? "min-w-[var(--pane-results)] flex-1" : undefined}>
      <label className="block text-caption text-text-secondary" htmlFor={inputId}>
        Backup password
      </label>
      <input
        aria-describedby={
          invalid && errorDescriptionId !== undefined
            ? `${disclosureId} ${errorDescriptionId}`
            : disclosureId
        }
        aria-invalid={invalid}
        autoComplete="current-password"
        className={cn(
          "mt-1 w-full border border-border-strong bg-surface-sunken text-body text-text",
          inputSize === "lg"
            ? "h-[var(--control-height-lg)] rounded-sm px-3"
            : "h-[var(--control-height-md)] rounded-md px-2",
        )}
        disabled={disabled}
        id={inputId}
        name="password"
        ref={controller.inputRef}
        required={required}
        type="password"
      />
    </div>
  );

  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault();

        if (controller.isEmpty()) {
          onEmptySubmit?.();
          controller.focus();
          return;
        }

        onSubmit();
      }}
    >
      {layout === "inline" ? (
        <div className="flex flex-wrap items-end gap-3">
          {leading}
          {field}
          {actions}
        </div>
      ) : (
        <>
          {field}
          {actions}
        </>
      )}
      <p className="mt-2 text-caption text-text-secondary" id={disclosureId}>
        {disclosureLeadIn === undefined ? null : `${disclosureLeadIn} `}
        {backupPasswordDisclosure}
      </p>
      {children}
    </form>
  );
}
