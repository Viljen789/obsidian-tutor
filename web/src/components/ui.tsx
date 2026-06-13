/**
 * Shared UI primitives for the reading-room aesthetic: quiet 1px borders,
 * restrained surfaces, no heavy shadows or gradients. Every interactive element
 * has a calm transition. Components accept a `tone` ("accent" | "review" |
 * "neutral") so Learn and Review can stay visually distinct from one shared
 * vocabulary.
 */
import { clsx } from "clsx";
import { Loader2, type LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type Tone = "accent" | "review" | "neutral";

const TONE_TEXT: Record<Tone, string> = {
  accent: "text-accent",
  review: "text-review",
  neutral: "text-ink",
};

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  tone?: Tone;
  size?: "sm" | "md";
  loading?: boolean;
  icon?: LucideIcon;
};

export function Button({
  variant = "primary",
  tone = "accent",
  size = "md",
  loading = false,
  icon: Icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const toneBg =
    tone === "review" ? "bg-review" : tone === "neutral" ? "bg-ink" : "bg-accent";
  const toneRing =
    tone === "review"
      ? "focus-visible:ring-review/40"
      : tone === "neutral"
        ? "focus-visible:ring-ink/30"
        : "focus-visible:ring-accent/40";
  const toneBorder =
    tone === "review" ? "border-review/30" : tone === "neutral" ? "border-border" : "border-accent/30";

  return (
    <button
      disabled={disabled || loading}
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all duration-200",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        "disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "px-3 py-1.5 text-sm" : "px-4 py-2.5 text-sm",
        variant === "primary" && [toneBg, "text-white hover:opacity-90 active:scale-[0.98]"],
        variant === "secondary" && [
          "border bg-surface text-ink hover:bg-ink/[0.03] active:scale-[0.98]",
          toneBorder,
        ],
        variant === "ghost" && [TONE_TEXT[tone], "hover:bg-ink/[0.04]"],
        toneRing,
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 size={16} className="animate-spin" />
      ) : (
        Icon && <Icon size={16} />
      )}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Card — a quiet surface. No nested cards; use SectionHeading inside.
// ---------------------------------------------------------------------------

export function Card({
  children,
  className,
  as: As = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "li";
}) {
  return (
    <As
      className={clsx(
        "rounded-2xl border border-border bg-surface",
        className,
      )}
    >
      {children}
    </As>
  );
}

// ---------------------------------------------------------------------------
// Pill — small status / metadata token.
// ---------------------------------------------------------------------------

export function Pill({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  const styles: Record<Tone, string> = {
    accent: "bg-accent/10 text-accent",
    review: "bg-review/10 text-review",
    neutral: "bg-ink/[0.06] text-muted",
  };
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
        styles[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ProgressBar — mastery 0..1.
// ---------------------------------------------------------------------------

export function ProgressBar({
  value,
  tone = "accent",
  className,
}: {
  value: number;
  tone?: Tone;
  className?: string;
}) {
  const w = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const fill =
    tone === "review" ? "bg-review" : tone === "neutral" ? "bg-muted" : "bg-accent";
  return (
    <div
      className={clsx("h-1.5 w-full overflow-hidden rounded-full bg-ink/[0.07]", className)}
      role="progressbar"
      aria-valuenow={w}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={clsx("h-full rounded-full transition-[width] duration-500 ease-out", fill)}
        style={{ width: `${w}%` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spinner / loading + skeletons.
// ---------------------------------------------------------------------------

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted">
      <Loader2 size={16} className="animate-spin" />
      {label && <span>{label}</span>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("animate-pulse rounded-lg bg-ink/[0.06]", className)} />;
}

// ---------------------------------------------------------------------------
// EmptyState — thoughtful, never a blank screen.
// ---------------------------------------------------------------------------

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  tone = "neutral",
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  tone?: Tone;
}) {
  const iconBg =
    tone === "review"
      ? "bg-review/10 text-review"
      : tone === "accent"
        ? "bg-accent/10 text-accent"
        : "bg-ink/[0.05] text-muted";
  return (
    <div className="animate-fade flex flex-col items-center px-6 py-14 text-center">
      <div className={clsx("mb-4 grid h-12 w-12 place-items-center rounded-2xl", iconBg)}>
        <Icon size={22} />
      </div>
      <h3 className="font-serif text-xl text-ink">{title}</h3>
      {description && (
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted">{description}</p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ErrorState — friendly, with a retry. Never raw stack traces.
// ---------------------------------------------------------------------------

export function ErrorState({
  title = "Something went sideways",
  description = "We couldn't load this just now. The tutor's brain may still be waking up.",
  onRetry,
}: {
  title?: string;
  description?: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div className="animate-fade flex flex-col items-center px-6 py-12 text-center">
      <h3 className="font-serif text-xl text-ink">{title}</h3>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted">{description}</p>
      {onRetry && (
        <Button variant="secondary" tone="neutral" className="mt-5" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SectionHeading — small all-caps eyebrow + serif title, the editorial motif.
// ---------------------------------------------------------------------------

export function Eyebrow({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={clsx(
        "text-[0.7rem] font-semibold uppercase tracking-[0.14em]",
        TONE_TEXT[tone],
        tone === "neutral" && "text-muted",
      )}
    >
      {children}
    </span>
  );
}

/** A deterministic muted hue dot per subject — quiet visual grouping. */
export function SubjectDot({ subject, className }: { subject: string; className?: string }) {
  let h = 0;
  for (let i = 0; i < subject.length; i++) h = (h * 31 + subject.charCodeAt(i)) % 360;
  return (
    <span
      className={clsx("inline-block h-2 w-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: `hsl(${h} 35% 55%)` }}
      aria-hidden
    />
  );
}
