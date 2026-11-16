import { create } from "zustand";
import { AiError, askAi } from "../ai/client";
import type { Workspace } from "../types";
import { answerFromModel, citedObjects, modelContext, searchFallback, type Answer } from "./ask";

const AI_CHOICE_KEY = "archone.ask.useAi";

/** Whether the person agreed to send the model to the AI model for questions the built-in reader cannot answer. */
export function getAiChoice(): boolean {
  try {
    return localStorage.getItem(AI_CHOICE_KEY) === "yes";
  } catch {
    return false;
  }
}
export function setAiChoice(on: boolean) {
  try {
    localStorage.setItem(AI_CHOICE_KEY, on ? "yes" : "no");
  } catch {
    // Private browsing: the choice lasts for this visit only.
  }
}

/**
 * Answers a question. The model is read first; the AI model is asked only when that cannot
 * answer, one is configured, and the person allowed it. A refusal (access code, sign-in) is
 * thrown so the page can say what to do; any other trouble ends in the matching objects.
 */
export async function ask(ws: Workspace, question: string, options: { aiConfigured: boolean; useAi: boolean }): Promise<Answer> {
  const computed = answerFromModel(ws, question);
  if (computed) return computed;
  if (!Object.keys(ws.objects).length) return searchFallback(ws, question, "The model is empty, so there is nothing to answer from yet.");
  if (!options.aiConfigured) {
    return searchFallback(ws, question, "This question is not one the built-in reader can work out, and no AI model is configured on this server.");
  }
  if (!options.useAi) {
    return searchFallback(ws, question, "This question is not one the built-in reader can work out. Tick the box above the answers to have the AI model answer it.");
  }
  const context = modelContext(ws);
  try {
    const { answer, engine } = await askAi(question, context.text);
    const text = context.complete ? answer : `${answer}\n\nThe model was too large to send whole, so this answer rests on part of it.`;
    const diagramIds = Object.values(ws.diagrams)
      .filter((d) => d.name.trim().length >= 3 && answer.toLowerCase().includes(d.name.trim().toLowerCase()))
      .map((d) => d.id);
    return { text, objectIds: citedObjects(ws, text), diagramIds, source: "ai", engine };
  } catch (error) {
    if (error instanceof AiError && error.code === "access_code") throw error;
    const why = error instanceof AiError && error.code === "not_configured" ? "No AI model is configured on this server." : `The AI model could not answer: ${error instanceof Error ? error.message : "unknown error"}`;
    return searchFallback(ws, question, why);
  }
}

export interface Exchange {
  id: number;
  question: string;
  answer: Answer;
}

/** The questions asked in this visit, newest first. Kept in memory only, so leaving the page and coming back keeps them. */
export const useAskHistory = create<{ workspaceId: string | null; exchanges: Exchange[] }>(() => ({ workspaceId: null, exchanges: [] }));
let nextId = 1;
export function rememberExchange(workspaceId: string, question: string, answer: Answer) {
  useAskHistory.setState((s) => ({
    workspaceId,
    exchanges: [{ id: nextId++, question, answer }, ...(s.workspaceId === workspaceId ? s.exchanges : [])].slice(0, 30),
  }));
}
export const clearExchanges = () => useAskHistory.setState({ exchanges: [] });
