/**
 * Vector memory hook handler
 *
 * Automatically indexes messages into vector database and injects relevant context
 * during session bootstrap using the existing ~/clawd/embeddings/ system.
 */

import { exec, spawn } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import {
  isMessageReceivedEvent,
  isMessageSentEvent,
  isAgentBootstrapEvent,
  type MessageReceivedHookEvent,
  type MessageSentHookEvent,
  type AgentBootstrapHookEvent,
} from "../../internal-hooks.js";

const log = createSubsystemLogger("hooks/vector-memory");
const execAsync = promisify(exec);

// Configuration constants
const EMBEDDINGS_DIR = `${os.homedir()}/clawd/embeddings`;
const DEFAULT_SEARCH_TIMEOUT = 5000; // 5 seconds
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_QUERY_LENGTH = 200;

interface SearchResultItem {
  similarity?: number;
  content?: string;
  source?: string;
  location?: string;
}

/**
 * Escape text for safe shell execution
 */
function escapeShellText(text: string): string {
  return text.replace(/'/g, "'\"'\"'");
}

/**
 * Extract text content from message (handling both string and array formats)
 */
function extractMessageText(content: unknown): string | null {
  if (typeof content === "string") {
    return content.trim() || null;
  }

  if (Array.isArray(content)) {
    const textBlock = content.find(
      (block) => block && typeof block === "object" && (block as { type?: string }).type === "text",
    ) as { text?: string } | undefined;
    return textBlock?.text?.trim() || null;
  }

  return null;
}

/**
 * Store message embedding asynchronously (fire-and-forget)
 */
function storeMessageAsync(
  text: string,
  metadata: Record<string, unknown>,
  source: string,
  sessionKey: string,
): void {
  // Prepare metadata for Python
  const metadataJson = JSON.stringify(metadata);

  // Build command
  const pythonCode = `
from embed import store_embedding
store_embedding('${escapeShellText(text)}', ${metadataJson}, '${source}')
`.trim();

  const command = `cd "${EMBEDDINGS_DIR}" && source venv/bin/activate && python3 -c "${pythonCode}"`;

  // Execute asynchronously without blocking
  const child = spawn("bash", ["-c", command], {
    detached: true,
    stdio: "ignore",
  });

  child.on("error", (err) => {
    log.error("Failed to store message embedding", {
      error: err.message,
      text: text.slice(0, 50) + "...",
      sessionKey,
    });
  });

  child.unref(); // Don't keep the process alive waiting for this

  log.debug("Queued message for embedding storage", {
    length: text.length,
    sessionKey,
    source,
  });
}

/**
 * Search vector database for relevant context (blocking, with timeout)
 */
async function searchVectorContext(
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
  timeoutMs: number = DEFAULT_SEARCH_TIMEOUT,
): Promise<Array<{
  similarity: number;
  content: string;
  source: string;
  location: string;
}> | null> {
  try {
    const escapedQuery = escapeShellText(query);
    const command = `cd "${EMBEDDINGS_DIR}" && source venv/bin/activate && python3 karen_search.py "${escapedQuery}" --limit ${limit} --json`;

    const { stdout, stderr } = await execAsync(command, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024, // 1MB buffer for results
    });

    if (stderr && stderr.trim()) {
      log.warn("Vector search stderr output", { stderr: stderr.trim(), query });
    }

    const result = JSON.parse(stdout);

    if (!result.results || !Array.isArray(result.results)) {
      log.warn("Invalid search result format", { query, result });
      return null;
    }

    log.debug("Vector search completed", {
      query,
      totalResults: result.total_results || result.results.length,
      returnedResults: result.results.length,
    });

    return result.results.map((r: SearchResultItem) => ({
      similarity: r.similarity || 0,
      content: r.content || "",
      source: r.source || "unknown",
      location: r.location || "unknown",
    }));
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error("Vector search failed", {
      error: errorMessage,
      query,
      timeout: timeoutMs,
    });
    return null;
  }
}

/**
 * Format search results for injection into context
 */
function formatContextResults(
  query: string,
  results: Array<{
    similarity: number;
    content: string;
    source: string;
    location: string;
  }>,
): string {
  const lines = [
    "## Relevant Context (Vector Search)",
    "",
    `**Query**: "${query}"`,
    "",
    "**Similar conversations:**",
  ];

  for (const result of results) {
    const similarity = result.similarity.toFixed(3);
    const preview =
      result.content.length > 100 ? result.content.slice(0, 97) + "..." : result.content;

    lines.push(`- [${similarity}] ${result.location}: "${preview}"`);
  }

  lines.push(""); // Empty line at end

  return lines.join("\n");
}

/**
 * Get search query from bootstrap context
 */
function getSearchQuery(event: AgentBootstrapHookEvent): string | null {
  // Try to get the session ID to read recent messages
  const sessionId = event.context.sessionId?.trim();
  if (!sessionId) {
    return null;
  }

  // For now, use a simple fallback query based on context
  // In the future, we could read from session file to get recent messages
  const query = `session ${sessionId} recent conversation`;

  return query.slice(0, MAX_QUERY_LENGTH);
}

/**
 * Handle message received events
 */
async function handleMessageReceived(event: MessageReceivedHookEvent): Promise<void> {
  const text = extractMessageText(event.context.content);
  if (!text || text.startsWith("/")) {
    return; // Skip empty messages and commands
  }

  const metadata = {
    sender: "user",
    channel: event.context.channelId || "unknown",
    timestamp: event.context.timestamp || Date.now(),
    messageId: event.context.messageId,
    from: event.context.from,
  };

  storeMessageAsync(text, metadata, "chat", event.sessionKey);
}

/**
 * Handle message sent events
 */
async function handleMessageSent(event: MessageSentHookEvent): Promise<void> {
  if (!event.context.success) {
    return; // Don't store failed sends
  }

  const text = extractMessageText(event.context.content);
  if (!text) {
    return; // Skip empty responses
  }

  const metadata = {
    sender: "assistant",
    channel: event.context.channelId || "unknown",
    timestamp: Date.now(),
    messageId: event.context.messageId,
    to: event.context.to,
  };

  storeMessageAsync(text, metadata, "chat", event.sessionKey);
}

/**
 * Handle agent bootstrap events
 */
async function handleAgentBootstrap(event: AgentBootstrapHookEvent): Promise<void> {
  // Get hook configuration
  const hookConfig = resolveHookConfig(event.context.cfg, "vector-memory");
  const searchTimeout =
    typeof hookConfig?.timeout === "number" && hookConfig.timeout > 0
      ? hookConfig.timeout * 1000 // Convert to milliseconds
      : DEFAULT_SEARCH_TIMEOUT;
  const searchLimit =
    typeof hookConfig?.limit === "number" && hookConfig.limit > 0
      ? hookConfig.limit
      : DEFAULT_SEARCH_LIMIT;

  // Get search query from context
  const query = getSearchQuery(event);
  if (!query) {
    log.debug("No search query available for bootstrap", { sessionKey: event.sessionKey });
    return;
  }

  // Search for relevant context
  const results = await searchVectorContext(query, searchLimit, searchTimeout);
  if (!results || results.length === 0) {
    log.debug("No relevant context found", { query, sessionKey: event.sessionKey });
    return;
  }

  // Format and inject context
  const contextContent = formatContextResults(query, results);

  // Inject as a bootstrap file
  event.context.bootstrapFiles.push({
    name: "VECTOR_CONTEXT.md",
    path: `<vector-memory>`, // Virtual path
    content: contextContent,
    missing: false,
  });

  log.info("Injected vector memory context", {
    sessionKey: event.sessionKey,
    query,
    resultsCount: results.length,
    topSimilarity: results[0]?.similarity || 0,
  });
}

/**
 * Main hook handler
 */
const vectorMemoryHook: HookHandler = async (event) => {
  try {
    if (isMessageReceivedEvent(event)) {
      await handleMessageReceived(event);
    } else if (isMessageSentEvent(event)) {
      await handleMessageSent(event);
    } else if (isAgentBootstrapEvent(event)) {
      await handleAgentBootstrap(event);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error("Vector memory hook error", {
      error: errorMessage,
      eventType: event.type,
      eventAction: event.action,
      sessionKey: event.sessionKey,
    });
  }
};

export default vectorMemoryHook;
