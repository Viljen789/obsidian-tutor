/**
 * Settings. Surfaces the three learner-model knobs that already live in the
 * contract (CONTRACTS.md / @tutor/shared UserSettings) but had no UI, plus a
 * dark-mode toggle and a gentle re-import nudge.
 *
 * The thresholds are mastery probabilities (0..1), shown as percentages because
 * that reads more naturally to a learner. `dailyNewLimit` is a whole count. We
 * load into local draft state, let the learner tinker, and persist explicitly
 * with a dirty-aware "Save changes" — thresholds are the kind of thing you want
 * to set deliberately, not nudge live on every slider tick. Settings live as a
 * nested field on the profile doc, so the writer (lib/settings.ts) merges.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Check,
  Minus,
  Moon,
  Plus,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Sparkles,
  Sun,
} from "lucide-react";
import type { UserSettings } from "@tutor/shared";
import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import {
  clampSettings,
  saveSettings,
  useInvalidateSettings,
  useSettings,
} from "../lib/settings";
import {
  Button,
  Card,
  ErrorState,
  Eyebrow,
  Pill,
  Skeleton,
  Spinner,
} from "../components/ui";

type SaveState = "idle" | "saving" | "saved" | "error";

export function Settings() {
  const { user } = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();
  const { data, isLoading, isError, refetch } = useSettings();
  const invalidateSettings = useInvalidateSettings();

  // Local draft of the form, seeded from the loaded settings.
  const [draft, setDraft] = useState<UserSettings | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  // Seed (and re-seed after a successful refetch) the draft from server state.
  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  const dirty = useMemo(
    () => !!data && !!draft && !settingsEqual(data, draft),
    [data, draft],
  );

  const patch = (next: Partial<UserSettings>) => {
    setDraft((d) => (d ? clampSettings({ ...d, ...next }) : d));
    // A fresh edit invalidates any prior "saved" confirmation.
    setSaveState((s) => (s === "saved" || s === "error" ? "idle" : s));
  };

  const onSave = async () => {
    if (!user || !draft || !dirty) return;
    setSaveState("saving");
    setSaveError(null);
    try {
      const saved = await saveSettings(user.uid, draft);
      setDraft(saved);
      await invalidateSettings();
      setSaveState("saved");
    } catch (e) {
      setSaveError(
        e instanceof Error && e.message
          ? e.message
          : "Couldn't save your settings. Please try again.",
      );
      setSaveState("error");
    }
  };

  return (
    <div className="animate-fade space-y-7">
      <header>
        <Eyebrow tone="accent">Settings</Eyebrow>
        <h1 className="mt-1.5 font-serif text-[2rem] tracking-tight text-ink">
          Tune your tutor
        </h1>
        <p className="mt-1 max-w-lg text-[0.95rem] leading-relaxed text-muted">
          These knobs shape how the tutor paces you — when it treats a
          prerequisite as learned, how much is genuinely new each day, and what
          counts as mastered. Adjust to taste; you can change them anytime.
        </p>
      </header>

      {isLoading || !draft ? (
        <LoadingCard />
      ) : isError ? (
        <Card>
          <ErrorState
            title="Couldn't load your settings"
            description="Your saved preferences didn't come through. Give it another go."
            onRetry={() => void refetch()}
          />
        </Card>
      ) : (
        <>
          {/* Learner-model knobs */}
          <Card className="p-6">
            <div className="flex items-center gap-2">
              <SlidersHorizontal size={15} className="text-accent" />
              <Eyebrow tone="accent">Learner model</Eyebrow>
            </div>

            <div className="mt-5 space-y-7">
              <ThresholdRow
                label="Prerequisite mastery"
                help="A prerequisite counts as learned at or above this mastery — raise it to insist on firmer foundations before moving on."
                value={draft.masteryThreshold}
                onChange={(v) => patch({ masteryThreshold: v })}
              />

              <DailyLimitRow
                value={draft.dailyNewLimit}
                onChange={(v) => patch({ dailyNewLimit: v })}
              />

              <ThresholdRow
                label="Mastered at"
                help="Mastery at or above this marks a concept “Mastered”. Higher means the tutor keeps reviewing for longer before it lets go."
                value={draft.masteredThreshold}
                onChange={(v) => patch({ masteredThreshold: v })}
              />
            </div>
          </Card>

          {/* Save bar */}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              icon={Save}
              disabled={!dirty}
              loading={saveState === "saving"}
              onClick={() => void onSave()}
            >
              {saveState === "saving" ? "Saving…" : "Save changes"}
            </Button>
            {saveState === "saved" && !dirty && (
              <Pill tone="accent">
                <Check size={13} /> Saved
              </Pill>
            )}
            {saveState === "error" && (
              <span className="text-sm text-review">
                {saveError ?? "Couldn't save. Try again."}
              </span>
            )}
            {dirty && saveState !== "saving" && (
              <span className="text-sm text-muted">Unsaved changes</span>
            )}
          </div>

          {/* Appearance */}
          <Card className="p-6">
            <Eyebrow>Appearance</Eyebrow>
            <div className="mt-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-[0.95rem] font-medium text-ink">Dark mode</p>
                <p className="mt-0.5 text-sm leading-relaxed text-muted">
                  Easier on the eyes for late-night study. Applies instantly.
                </p>
              </div>
              <ThemeToggle theme={theme} onToggle={toggleTheme} />
            </div>
          </Card>

          {/* Re-import nudge */}
          <ReimportNudge />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A 0..1 threshold, presented and edited as a percentage.
// ---------------------------------------------------------------------------

function ThresholdRow({
  label,
  help,
  value,
  onChange,
}: {
  label: string;
  help: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label className="text-[0.95rem] font-medium text-ink">{label}</label>
        <span className="font-serif text-lg tabular-nums text-accent">
          {Math.round(value * 100)}%
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        className="mt-3 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-ink/[0.08] accent-[rgb(var(--accent))]"
      />
      <p className="mt-2 text-sm leading-relaxed text-muted">{help}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// dailyNewLimit — a whole, non-negative count. Stepper + direct number entry.
// ---------------------------------------------------------------------------

function DailyLimitRow({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const set = (n: number) => onChange(Math.max(0, Math.round(n)));
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="daily-new-limit" className="text-[0.95rem] font-medium text-ink">
          New concepts per day
        </label>
        <div className="flex items-center gap-1.5">
          <StepButton
            label="Fewer"
            icon={Minus}
            disabled={value <= 0}
            onClick={() => set(value - 1)}
          />
          <input
            id="daily-new-limit"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={value}
            onChange={(e) => set(Number(e.target.value))}
            className="w-14 rounded-lg border border-border bg-bg/50 py-1.5 text-center font-serif text-lg tabular-nums text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          <StepButton label="More" icon={Plus} onClick={() => set(value + 1)} />
        </div>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        The most brand-new concepts to introduce in a day. Reviews of what you
        already know aren't capped — this only limits fresh material, so days
        stay digestible. Set to 0 to review only.
      </p>
    </div>
  );
}

function StepButton({
  label,
  icon: Icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: typeof Plus;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-surface text-ink transition-colors hover:bg-ink/[0.04] disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Icon size={15} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Dark-mode toggle (wired to the shared useTheme store).
// ---------------------------------------------------------------------------

function ThemeToggle({
  theme,
  onToggle,
}: {
  theme: "light" | "dark";
  onToggle: () => void;
}) {
  const dark = theme === "dark";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label="Toggle dark mode"
      onClick={onToggle}
      className="relative inline-flex h-9 w-16 shrink-0 items-center rounded-full border border-border bg-bg/60 px-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      <span
        className={
          "grid h-7 w-7 place-items-center rounded-full bg-surface text-accent shadow-sm transition-transform duration-200 " +
          (dark ? "translate-x-7" : "translate-x-0")
        }
      >
        {dark ? <Moon size={15} /> : <Sun size={15} />}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Quiet nudge to re-import so older concepts pick up the latest parsing.
// ---------------------------------------------------------------------------

function ReimportNudge() {
  const navigate = useNavigate();
  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
          <Sparkles size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[0.95rem] font-medium text-ink">Keep concepts fresh</p>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            Re-import your vault to apply the latest parsing — inline{" "}
            <code className="rounded bg-ink/[0.06] px-1 py-0.5 text-[0.85em] text-ink">
              #tags
            </code>{" "}
            and MOC-based ordering — to concepts you imported earlier. It's
            idempotent: your progress stays put.
          </p>
          <Button
            variant="secondary"
            tone="neutral"
            size="sm"
            icon={RefreshCw}
            className="mt-3"
            onClick={() => navigate("/import")}
          >
            Re-import vault
            <ArrowRight size={14} />
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function LoadingCard() {
  return (
    <Card className="p-6">
      <Skeleton className="h-3 w-28" />
      <div className="mt-6 space-y-7">
        {[0, 1, 2].map((i) => (
          <div key={i}>
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-12" />
            </div>
            <Skeleton className="mt-3 h-1.5 w-full" />
            <Skeleton className="mt-2 h-3 w-3/4" />
          </div>
        ))}
      </div>
      <div className="mt-6">
        <Spinner label="Loading your settings…" />
      </div>
    </Card>
  );
}

function settingsEqual(a: UserSettings, b: UserSettings): boolean {
  return (
    a.masteryThreshold === b.masteryThreshold &&
    a.dailyNewLimit === b.dailyNewLimit &&
    a.masteredThreshold === b.masteredThreshold
  );
}
