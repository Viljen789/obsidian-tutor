/**
 * "Listen" control — speaks the current explanation aloud using the browser's
 * Web Speech API (free, native, no backend). It sits quietly in the Lesson's
 * explanation header, so it stays compact and low-key: a single
 * Play / Pause / Resume toggle plus a Stop, nothing more.
 *
 * State machine (three states, driven by user clicks + utterance callbacks):
 *
 *     idle  ──Play──▶  speaking  ──Pause──▶  paused
 *       ▲                  │  ▲                  │
 *       └──Stop / onEnd────┘  └──────Resume──────┘
 *                  (Stop from any non-idle state → idle)
 *
 * `onEnd` (fired by the speech engine when the utterance finishes, errors, or
 * is cancelled) always returns us to `idle`. We `cancel()` any in-flight speech
 * on unmount and whenever `text` changes, because `speechSynthesis` is a global
 * queue that otherwise keeps talking across navigation.
 */
import { Pause, Play, Square, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button, type Tone } from "@/components/ui";
import {
  markdownToSpeech,
  speak,
  speechSupported,
  type SpeechControls,
} from "@/lib/speech";

type PlayState = "idle" | "speaking" | "paused";

export function ReadAloud({ text, tone = "accent" }: { text: string; tone?: Tone }) {
  const [state, setState] = useState<PlayState>("idle");
  const controlsRef = useRef<SpeechControls | null>(null);

  // Compute once whether the platform can speak. If not, render nothing — a
  // dead button is worse than no button. (`speechSupported` is stable, so this
  // value never changes across the component's life.)
  const supported = speechSupported();

  // Stop any ongoing speech on unmount, and whenever the source text changes
  // (e.g. navigating to a different concept): the global queue would otherwise
  // narrate the previous explanation over the new screen.
  useEffect(() => {
    return () => {
      controlsRef.current?.cancel();
      controlsRef.current = null;
    };
  }, [text]);

  if (!supported) return null;

  const stop = () => {
    controlsRef.current?.cancel();
    controlsRef.current = null;
    setState("idle");
  };

  const start = () => {
    const prose = markdownToSpeech(text);
    if (!prose) return; // nothing speakable — stay idle.
    controlsRef.current?.cancel();
    controlsRef.current = speak(prose, {
      onEnd: () => {
        controlsRef.current = null;
        setState("idle");
      },
    });
    setState("speaking");
  };

  // The primary button cycles through the state machine on each click.
  const onPrimary = () => {
    if (state === "idle") {
      start();
    } else if (state === "speaking") {
      controlsRef.current?.pause();
      setState("paused");
    } else {
      controlsRef.current?.resume();
      setState("speaking");
    }
  };

  const speaking = state === "speaking";
  const paused = state === "paused";

  // Tone drives the accent colour of the active (ghost) control so Listen reads
  // as part of Learn (accent) or Review (review) without extra chrome.
  const activeTone: Tone = speaking || paused ? tone : "neutral";

  const PrimaryIcon = speaking ? Pause : state === "paused" ? Play : Volume2;
  const primaryLabel = speaking ? "Pause reading" : paused ? "Resume reading" : "Read aloud";

  return (
    <div className="inline-flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        tone={activeTone}
        icon={PrimaryIcon}
        onClick={onPrimary}
        aria-label={primaryLabel}
        aria-pressed={speaking || paused}
        title={primaryLabel}
      >
        <span className="text-xs">{speaking ? "Pause" : paused ? "Resume" : "Listen"}</span>
      </Button>

      {(speaking || paused) && (
        <Button
          variant="ghost"
          size="sm"
          tone="neutral"
          icon={Square}
          onClick={stop}
          aria-label="Stop reading"
          title="Stop reading"
        />
      )}
    </div>
  );
}
