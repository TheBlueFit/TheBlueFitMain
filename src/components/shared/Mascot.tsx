/**
 * Brand mascot — the bull-skull coach.
 *
 * Flat vector art is the one style that survives every size we need it at
 * (30px in the app header through 116px on the sign-in card), so the same
 * character is used everywhere instead of mixing illustration styles.
 */

export type MascotVariant = "portrait" | "hero" | "cheer";

const ART: Record<MascotVariant, { src: string; intrinsic: number }> = {
  portrait: { src: "/mascot/mascot-avatar.jpg", intrinsic: 1024 },
  hero: { src: "/mascot/mascot-hero.jpg", intrinsic: 880 },
  cheer: { src: "/mascot/mascot-thumbs-up.jpg", intrinsic: 1024 },
};

type MascotProps = {
  variant?: MascotVariant;
  /** Rendered edge length in px. */
  size?: number;
  /** Optional height for non-square crops (e.g. the full-body pose). */
  height?: number;
  /** Gold ring + glow frame. Turn off for small inline uses. */
  framed?: boolean;
  /** Square (rounded) crop instead of the default circular one. */
  square?: boolean;
  className?: string;
  alt?: string;
};

export default function Mascot({
  variant = "portrait",
  size = 96,
  height,
  framed = true,
  square = false,
  className = "",
  alt = "",
}: MascotProps) {
  const art = ART[variant];
  const classes = [
    "bf-mascot",
    square || variant === "cheer" ? "bf-mascot--square" : "",
    framed ? "bf-mascot--framed" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={art.src}
      alt={alt}
      width={size}
      height={height ?? size}
      decoding="async"
      className={classes}
      style={{ width: size, height: height ?? size }}
    />
  );
}
