import { cn } from "../../lib/cn";

interface DecorativeIllustrationProps {
  className?: string;
  darkSrc: string;
  lightSrc: string;
}

/**
 * Renders both artwork variants so CSS can follow system and manual themes
 * without making React a second source of truth for the active theme.
 */
export function DecorativeIllustration({
  className,
  darkSrc,
  lightSrc,
}: DecorativeIllustrationProps) {
  return (
    <span aria-hidden="true" className={cn("golemine-illustration", className)}>
      <img
        alt=""
        className="golemine-illustration-light h-auto w-full"
        decoding="async"
        draggable={false}
        loading="lazy"
        src={lightSrc}
      />
      <img
        alt=""
        className="golemine-illustration-dark h-auto w-full"
        decoding="async"
        draggable={false}
        loading="lazy"
        src={darkSrc}
      />
    </span>
  );
}
