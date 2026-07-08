import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { type ComponentPropsWithoutRef, type ReactNode } from "react";

import { cn } from "../../lib/cn";

// Design.md §7: tooltips use a 400ms delay, --surface-raised background, and
// caption type; every icon-only button gets one. Not for use inside
// virtualized rows (D-014 performance constraint).
const tooltipDelayMs = 400;

export function TooltipProvider({
  children,
  ...props
}: ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider delayDuration={tooltipDelayMs} {...props}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export function Tooltip({
  children,
  content,
  ...props
}: ComponentPropsWithoutRef<typeof TooltipPrimitive.Root> & {
  content: ReactNode;
}) {
  return (
    <TooltipPrimitive.Root {...props}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipContent>{content}</TooltipContent>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

function TooltipContent({
  children,
  className,
  sideOffset = 6,
  ...props
}: ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Content
      className={cn(
        "z-50 rounded-md border border-border bg-surface-raised px-2 py-1 text-caption text-text shadow-2",
        className,
      )}
      sideOffset={sideOffset}
      {...props}
    >
      {children}
    </TooltipPrimitive.Content>
  );
}
