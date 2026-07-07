import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { type ComponentPropsWithoutRef } from "react";

import { cn } from "../../lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-body font-[var(--font-weight-strong)] disabled:pointer-events-none disabled:opacity-[var(--opacity-disabled)]",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-foreground shadow-1 hover:shadow-2",
        secondary: "border border-border bg-surface text-text hover:bg-surface-raised",
        ghost: "bg-transparent text-text-secondary hover:bg-surface-raised hover:text-text",
        destructive: "bg-danger text-danger-foreground shadow-1 hover:shadow-2",
      },
      size: {
        sm: "h-[var(--control-height-sm)] px-2 text-caption",
        md: "h-[var(--control-height-md)] px-3",
        lg: "h-[var(--control-height-lg)] px-4",
        icon: "size-[var(--control-height-md)] p-0",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends ComponentPropsWithoutRef<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ asChild = false, className, size, variant, ...props }: ButtonProps) {
  const Component = asChild ? Slot : "button";

  return <Component className={cn(buttonVariants({ className, size, variant }))} {...props} />;
}
