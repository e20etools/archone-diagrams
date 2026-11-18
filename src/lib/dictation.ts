import { useEffect, useRef, useState } from "react";

/**
 * Speaking instead of typing, with the browser's own speech recognition (Chrome, Edge and Safari
 * have it). The words are written into a field as they are recognised; nothing is recorded or kept.
 */

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

export function speechRecognition(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const DICTATION_LANGUAGES = [
  { id: "ar-SA", label: "العربية" },
  { id: "en-US", label: "English" },
] as const;

/** Dictation into a field: each finished phrase is handed to `onText`; what is still being heard is in `hearing`. */
export function useDictation(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [hearing, setHearing] = useState("");
  const [problem, setProblem] = useState("");
  const recognition = useRef<Recognition | null>(null);
  const handler = useRef(onText);
  useEffect(() => {
    handler.current = onText;
  });
  // Listening stops when the field goes.
  useEffect(() => () => recognition.current?.stop(), []);
  const Supported = speechRecognition();

  const toggle = (lang: string) => {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    if (!Supported) return;
    const r = new Supported();
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let done = "";
      let pending = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) done += result[0].transcript;
        else pending += result[0].transcript;
      }
      if (done.trim()) handler.current(done.trim());
      setHearing(pending);
    };
    r.onerror = (e) => setProblem(e.error === "not-allowed" || e.error === "service-not-allowed" ? "The browser was not allowed to use the microphone. Allow it in the address bar, or type instead." : `Dictation stopped: ${e.error}. You can type instead.`);
    r.onend = () => {
      setListening(false);
      setHearing("");
    };
    recognition.current = r;
    setProblem("");
    try {
      r.start();
      setListening(true);
    } catch {
      setProblem("Dictation could not start. Type instead.");
    }
  };
  return { supported: !!Supported, listening, hearing, problem, toggle };
}
