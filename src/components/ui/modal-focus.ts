import { type RefObject, useEffect } from "react";

/**
 * Everything a browser can put in the Tab order, including the entries the
 * classic short list forgets (contenteditable regions, media controls,
 * summary, iframes). Elements are still filtered for disabled/invisible
 * state at trap time.
 */
const focusableSelector = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "audio[controls]",
  "video[controls]",
  "summary",
  "iframe",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

function collectFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(focusableSelector),
  ).filter(
    (element) =>
      !element.hasAttribute("disabled") &&
      element.getClientRects().length > 0,
  );
}

/**
 * Single modal focus-containment mechanism for overlay dialogs: makes the app
 * root inert, keeps focus inside the container (both via a focusin backstop
 * and a Tab-order trap), focuses the container on activation, and dismisses
 * on Escape. Callers own return-focus policy — this hook never moves focus
 * outside the container.
 */
export function useModalFocusContainment({
  active,
  containerRef,
  onDismiss,
}: {
  active: boolean;
  containerRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
}): void {
  useEffect(() => {
    if (!active) {
      return;
    }

    const appRoot = document.getElementById("root");
    const rootWasInert = appRoot?.inert ?? false;
    const containFocus = (event: FocusEvent) => {
      const container = containerRef.current;
      const target = event.target;

      if (
        container !== null &&
        (!(target instanceof Node) || !container.contains(target))
      ) {
        container.focus();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const container = containerRef.current;

      if (container === null) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusable = collectFocusable(container);

      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable.at(-1);

      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === container)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          document.activeElement === container)
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    if (appRoot !== null) {
      appRoot.inert = true;
    }
    document.addEventListener("focusin", containFocus, true);
    document.addEventListener("keydown", handleKeyDown, true);
    containerRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", containFocus, true);
      if (appRoot !== null) {
        appRoot.inert = rootWasInert;
      }
    };
  }, [active, containerRef, onDismiss]);
}
