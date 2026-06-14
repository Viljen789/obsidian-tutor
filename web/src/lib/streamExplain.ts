/**
 * Streaming explanation hook.
 *
 * Calls the `explainConceptStream` streaming callable and surfaces the text as
 * it arrives, so the reading column fills in progressively instead of popping in
 * all at once. It is resilient by design: ANY problem with the streaming path
 * (unsupported, network, a shape mismatch) falls back to the plain
 * `explainConcept` callable — which is instant on a cache hit — so an
 * explanation always loads. Cached explanations stream as a single chunk.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import type { ExplainConceptResponse, ExplanationDepth } from "@tutor/shared";
import { functions } from "./firebase";
import { api } from "./api";

type Phase = "pending" | "streaming" | "success" | "error";

export interface UseExplanation {
  /** The explanation markdown — grows while streaming, canonical once done. */
  text: string;
  /** Final response metadata (depth / cached / model), set when complete. */
  data: ExplainConceptResponse | null;
  isPending: boolean; // requested, no text yet
  isStreaming: boolean; // text actively arriving
  isSuccess: boolean;
  isError: boolean;
  refetch: () => void;
}

interface StreamReq {
  conceptId: string;
  depth?: ExplanationDepth;
}

export function useExplanation(conceptId: string): UseExplanation {
  const [text, setText] = useState("");
  const [data, setData] = useState<ExplainConceptResponse | null>(null);
  const [phase, setPhase] = useState<Phase>("pending");
  // Guards against a stale in-flight request applying after the concept changes.
  const reqIdRef = useRef(0);

  const run = useCallback(() => {
    if (!conceptId) return;
    const myReq = ++reqIdRef.current;
    const live = () => reqIdRef.current === myReq;
    setText("");
    setData(null);
    setPhase("pending");

    void (async () => {
      try {
        const callable = httpsCallable<StreamReq, ExplainConceptResponse>(
          functions,
          "explainConceptStream",
        );
        const { stream, data: final } = await callable.stream({ conceptId });
        for await (const chunk of stream) {
          if (!live()) return;
          const piece = (chunk as { text?: string } | null)?.text;
          if (piece) {
            setText((t) => t + piece);
            setPhase("streaming");
          }
        }
        const res = await final;
        if (!live()) return;
        setData(res);
        setText(res.markdown); // canonical (trimmed) text
        setPhase("success");
      } catch {
        // Streaming unavailable/failed — fall back to the plain callable.
        try {
          const res = await api.explainConcept({ conceptId });
          if (!live()) return;
          setData(res);
          setText(res.markdown);
          setPhase("success");
        } catch {
          if (live()) setPhase("error");
        }
      }
    })();
  }, [conceptId]);

  useEffect(() => {
    run();
    // On concept change / unmount, bump the guard so late chunks are ignored.
    return () => {
      reqIdRef.current++;
    };
  }, [run]);

  return {
    text,
    data,
    isPending: phase === "pending" && text.length === 0,
    isStreaming: phase === "streaming",
    isSuccess: phase === "success",
    isError: phase === "error" && text.length === 0,
    refetch: run,
  };
}
