/**
 * dsh-voice-v host-side message lookup: the browser sends only
 * `sessionId` + `messageId`, and the host reads the assistant text out of the
 * session event log.
 *
 * This is the preferred variant of the two the task allows, because it keeps
 * the narration authoritative: whatever the durable transcript says is what
 * gets spoken, whatever the browser happens to have in its store.
 *
 * Two sources are tried in order:
 *
 *  * `ctx.sessions.get(sessionId)` — the live in-memory session log
 *    (`Session.snapshotEvents()`), which is what a session being viewed uses;
 *  * `ctx.sessionPersistence.open(sessionId, 'read')` — the durable JSONL log,
 *    for a session the host no longer holds live.
 *
 * The assistant message lives on an `assistant/message` surface event as
 * `event.data.message`; text comes from its `text` content blocks. Append-origin
 * events are preferred over surface replacements, matching the human transcript
 * rather than the model-visible surface. No `@deepseek-ai/*` import is needed:
 * the event shape is read structurally, so this module cannot break on a
 * service-identity or version mismatch.
 *
 * @module dsh-voice-v/session-text
 */

/**
 * Join the visible text blocks of one message.
 * @param message - A message object from an `assistant/message` event.
 * @returns The message's text, or an empty string when it carries none.
 */
export function messageText(message) {
  const content = message !== null && typeof message === 'object' ? message.content : undefined;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * Read a session's event log from the live store, falling back to persistence.
 * @param ctx - The plugin context.
 * @param sessionId - Logical session identity.
 * @returns The event array, or null when the session is unknown to the host.
 */
export async function readSessionEvents(ctx, sessionId) {
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
  if (sessions !== undefined && typeof sessions.get === 'function') {
    const live = sessions.get(sessionId);
    if (live !== undefined && typeof live.snapshotEvents === 'function') {
      const events = live.snapshotEvents();
      if (Array.isArray(events)) return events;
    }
  }

  const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined;
  if (persistence === undefined || typeof persistence.open !== 'function') return null;
  let handle;
  try {
    handle = await persistence.open(sessionId, 'read');
  } catch {
    return null;
  }
  try {
    const result = await handle.read();
    const events = result !== null && typeof result === 'object' ? result.events : undefined;
    return Array.isArray(events) ? events : [];
  } finally {
    if (handle !== undefined && typeof handle.close === 'function') {
      await handle.close().catch(() => {});
    }
  }
}

/**
 * Find the narration text for one assistant message.
 *
 * With a `messageId`, exactly that message is addressed. Without one — or when
 * the addressed id is not in the log — the last assistant message with text is
 * used, which is what a "read the answer" button wants when a client could not
 * observe the durable id.
 * @param ctx - The plugin context.
 * @param sessionId - Logical session identity.
 * @param messageId - Durable assistant message identity, or empty.
 * @returns The message text, or null when nothing usable was found.
 */
export async function readAssistantMessageText(ctx, sessionId, messageId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return null;
  let events;
  try {
    events = await readSessionEvents(ctx, sessionId);
  } catch {
    return null;
  }
  if (events === null) return null;

  const wanted = typeof messageId === 'string' ? messageId.trim() : '';
  let appendMatch = null;
  let replacementMatch = null;
  let lastText = null;

  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type !== 'assistant/message') continue;
    const data = event.data;
    const message = data !== null && typeof data === 'object' ? data.message : undefined;
    if (message === null || message === undefined) continue;
    const text = messageText(message);
    if (text === '') continue;
    const isAppend = event.surfaceOp === 'append';
    if (isAppend) lastText = text;
    if (wanted !== '' && message.id === wanted) {
      if (isAppend) appendMatch = text;
      else if (replacementMatch === null) replacementMatch = text;
    }
  }

  if (wanted !== '') return appendMatch ?? replacementMatch ?? null;
  return lastText;
}

/**
 * Read an assistant message and report where the text came from.
 * @param ctx - The plugin context.
 * @param sessionId - Logical session identity.
 * @param messageId - Durable assistant message identity, or empty.
 * @returns `{ text, source }`; `source` is `'session'` or `'none'`.
 */
export async function resolveAssistantText(ctx, sessionId, messageId) {
  const text = await readAssistantMessageText(ctx, sessionId, messageId);
  return { text, source: text === null ? 'none' : 'session' };
}
