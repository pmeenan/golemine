import * as Dialog from "@radix-ui/react-dialog";
import { type ReactNode } from "react";

import { Button } from "./button";
import "./confirmation-dialog.css";

export function ConfirmationDialog({
  cancelLabel,
  children,
  confirmLabel,
  onCancel,
  onConfirm,
  open,
  title,
}: {
  cancelLabel: string;
  children: ReactNode;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
  title: string;
}) {
  return (
    <Dialog.Root
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onCancel();
        }
      }}
      open={open}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="golemine-confirm-overlay fixed inset-0 z-50 bg-[var(--overlay-scrim)]" />
        <Dialog.Content className="golemine-confirm-content fixed left-1/2 top-1/2 z-50 w-[calc(100%_-_var(--space-32))] max-w-[var(--layout-dialog-confirm)] rounded-lg border border-border bg-surface-raised p-5 text-text shadow-3">
          <Dialog.Title className="text-heading text-text">{title}</Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-3 text-body text-text-secondary">{children}</div>
          </Dialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button type="button" variant="secondary">
                {cancelLabel}
              </Button>
            </Dialog.Close>
            <Button onClick={onConfirm} type="button" variant="destructive">
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
