import { InMemoryHistoryStore } from "@mediabox/chat-core";

const CHAT_TTL_MS = 2 * 60 * 60 * 1000; // 2 h

/** Singleton in-memory store for all active conversations. */
export const chatHistory = new InMemoryHistoryStore(CHAT_TTL_MS);
