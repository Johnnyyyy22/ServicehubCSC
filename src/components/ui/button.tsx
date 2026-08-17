import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Nocturne: the primary action is an accent OUTLINE, never a fill.
        default:
          "border border-primary text-primary bg-transparent hover:bg-primary/12 active:bg-primary/22",
        // No danger hue in this mono-accent system — a destructive action
        // reads the same as a neutral secondary one (divider border).
        destructive:
          "border border-border bg-transparent text-foreground hover:bg-foreground/7 active:bg-foreground/14",
        outline:
          "border border-border bg-transparent hover:bg-foreground/7 active:bg-foreground/14",
        secondary:
          "border border-border bg-transparent text-foreground hover:bg-foreground/7 active:bg-foreground/14",
        ghost: "text-primary hover:bg-primary/10 active:bg-primary/18",
        link: "text-accent-300 underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
