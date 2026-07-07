import { cva, type VariantProps } from "class-variance-authority";
import { type ComponentPropsWithoutRef } from "react";

import { cn } from "../../lib/cn";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2 py-0.5 text-micro",
  {
    variants: {
      variant: {
        neutral: "border-border bg-surface-sunken text-text-secondary",
        accent: "border-transparent bg-accent-subtle text-accent-text",
        success: "border-transparent bg-[var(--success-subtle)] text-[var(--success-foreground)]",
        warning: "border-transparent bg-[var(--warning-subtle)] text-[var(--warning-foreground)]",
        danger: "border-transparent bg-danger-subtle text-danger",
        info: "border-transparent bg-[var(--info-subtle)] text-[var(--info-foreground)]",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  },
);

export interface BadgeProps
  extends ComponentPropsWithoutRef<"span">,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ className, variant }))} {...props} />;
}
