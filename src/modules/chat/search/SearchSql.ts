import type { ParsedSearchQuery } from "./SearchQuery";
import type { MessageSearchOrder } from "./SearchCursor";

export interface BoundSearchSql {
  sql: string;
  params: unknown[];
}

function buildTermPredicate(
  column: string,
  terms: string[],
): { sql: string; params: string[] } {
  return {
    sql: terms.map(() => `instr(${column}, ?) > 0`).join(" AND "),
    params: [...terms],
  };
}

export function buildIndexedMessageSummarySql(
  query: ParsedSearchQuery,
  targetVersion: number,
): BoundSearchSql {
  const terms = buildTermPredicate("m.search_text", query.terms);
  return {
    sql: `SELECT m.session_id,
      COUNT(*) AS total_message_matches,
      MIN(CASE WHEN instr(m.search_text, ?) > 0 THEN 0 ELSE 1 END) AS best_message_category
    FROM messages m
    INNER JOIN session_meta sm ON sm.id = m.session_id
    WHERE m.search_index_version = ?
      AND sm.message_count > 0
      AND ${terms.sql}
    GROUP BY m.session_id`,
    params: [query.exactPhrase, targetVersion, ...terms.params],
  };
}

export function buildIndexedTitleMatchesSql(
  query: ParsedSearchQuery,
  targetVersion: number,
): BoundSearchSql {
  return {
    sql: `SELECT id, title, search_title, updated_at
    FROM session_meta
    WHERE message_count > 0
      AND search_index_version = ?
      AND instr(search_title, ?) > 0`,
    params: [targetVersion, query.exactPhrase],
  };
}

export function buildIndexedMessageCandidatesSql(
  query: ParsedSearchQuery,
  targetVersion: number,
  sessionIds: string[],
  candidateLimit: number = 3,
): BoundSearchSql {
  if (sessionIds.length === 0) {
    return { sql: "SELECT id FROM messages WHERE 0", params: [] };
  }
  const terms = buildTermPredicate("m.search_text", query.terms);
  const sessions = sessionIds.map(() => "?").join(", ");
  return {
    sql: `SELECT id, session_id, seq, role, timestamp, category
    FROM (
      WITH ranked AS (
        SELECT m.id, m.session_id, m.seq, m.role, m.timestamp,
          CASE WHEN instr(m.search_text, ?) > 0 THEN 0 ELSE 1 END AS category,
          ROW_NUMBER() OVER (
            PARTITION BY m.session_id
            ORDER BY
              CASE WHEN instr(m.search_text, ?) > 0 THEN 0 ELSE 1 END ASC,
              m.timestamp DESC,
              m.seq DESC,
              m.id COLLATE BINARY ASC
          ) AS search_rank
        FROM messages m
        WHERE m.search_index_version = ?
          AND m.session_id IN (${sessions})
          AND ${terms.sql}
      )
      SELECT id, session_id, seq, role, timestamp, category, search_rank
      FROM ranked
      WHERE search_rank <= ?
    )
    ORDER BY session_id COLLATE BINARY, search_rank ASC`,
    params: [
      query.exactPhrase,
      query.exactPhrase,
      targetVersion,
      ...sessionIds,
      ...terms.params,
      candidateLimit,
    ],
  };
}

export function buildIndexedSessionMessageSummarySql(
  query: ParsedSearchQuery,
  targetVersion: number,
  sessionId: string,
): BoundSearchSql {
  const terms = buildTermPredicate("m.search_text", query.terms);
  return {
    sql: `SELECT COUNT(*) AS total_message_matches,
      MIN(CASE WHEN instr(m.search_text, ?) > 0 THEN 0 ELSE 1 END) AS best_message_category
    FROM messages m
    INNER JOIN session_meta sm ON sm.id = m.session_id
    WHERE m.search_index_version = ?
      AND m.session_id = ?
      AND sm.message_count > 0
      AND ${terms.sql}`,
    params: [query.exactPhrase, targetVersion, sessionId, ...terms.params],
  };
}

/**
 * Return one current-version message page in the public ranking order. The
 * cursor predicate is expressed against the projected category so every
 * component stays bound and SQLite can apply the final hard limit.
 */
export function buildIndexedSessionMessagePageSql(
  query: ParsedSearchQuery,
  targetVersion: number,
  sessionId: string,
  limit: number,
  cursor?: MessageSearchOrder,
): BoundSearchSql {
  const terms = buildTermPredicate("m.search_text", query.terms);
  const cursorPredicate = cursor
    ? `WHERE category > ?
      OR (category = ? AND (
        timestamp < ?
        OR (timestamp = ? AND (
          seq < ?
          OR (seq = ? AND id COLLATE BINARY > ?)
        ))
      ))`
    : "";
  return {
    sql: `SELECT id, session_id, seq, role, timestamp, category
    FROM (
      SELECT m.id, m.session_id, m.seq, m.role, m.timestamp,
        CASE WHEN instr(m.search_text, ?) > 0 THEN 0 ELSE 1 END AS category
      FROM messages m
      INNER JOIN session_meta sm ON sm.id = m.session_id
      WHERE m.search_index_version = ?
        AND m.session_id = ?
        AND sm.message_count > 0
        AND ${terms.sql}
    )
    ${cursorPredicate}
    ORDER BY category ASC, timestamp DESC, seq DESC, id COLLATE BINARY ASC
    LIMIT ?`,
    params: cursor
      ? [
          query.exactPhrase,
          targetVersion,
          sessionId,
          ...terms.params,
          cursor.category,
          cursor.category,
          cursor.messageTimestamp,
          cursor.messageTimestamp,
          cursor.messageSeq,
          cursor.messageSeq,
          cursor.messageId,
          limit,
        ]
      : [query.exactPhrase, targetVersion, sessionId, ...terms.params, limit],
  };
}

export function buildLowerVersionMessagePageSql(
  targetVersion: number,
  limit: number,
  cursor?: { searchIndexVersion: number; id: string },
): BoundSearchSql {
  const cursorPredicate = cursor
    ? `AND (
        search_index_version > ?
        OR (search_index_version = ? AND id COLLATE BINARY > ?)
      )`
    : "";
  return {
    sql: `SELECT id, session_id, seq, role, content, timestamp,
      selected_text, tool_calls, tool_call_id, streaming_state,
      api_only, is_system_notice, quoted_messages,
      search_index_version
    FROM messages
    WHERE search_index_version < ?
      ${cursorPredicate}
    ORDER BY search_index_version ASC, id COLLATE BINARY ASC
    LIMIT ?`,
    params: cursor
      ? [
          targetVersion,
          cursor.searchIndexVersion,
          cursor.searchIndexVersion,
          cursor.id,
          limit,
        ]
      : [targetVersion, limit],
  };
}

export function buildLowerVersionTitlePageSql(
  targetVersion: number,
  limit: number,
  cursor?: { searchIndexVersion: number; id: string },
): BoundSearchSql {
  const cursorPredicate = cursor
    ? `AND (
        search_index_version > ?
        OR (search_index_version = ? AND id COLLATE BINARY > ?)
      )`
    : "";
  return {
    sql: `SELECT id, title, updated_at, message_count, search_index_version
    FROM session_meta
    WHERE search_index_version < ?
      ${cursorPredicate}
    ORDER BY search_index_version ASC, id COLLATE BINARY ASC
    LIMIT ?`,
    params: cursor
      ? [
          targetVersion,
          cursor.searchIndexVersion,
          cursor.searchIndexVersion,
          cursor.id,
          limit,
        ]
      : [targetVersion, limit],
  };
}

export function buildAllSourceMessagePageSql(
  limit: number,
  cursor?: { searchIndexVersion: number; id: string },
): BoundSearchSql {
  const cursorPredicate = cursor
    ? `WHERE search_index_version > ?
        OR (search_index_version = ? AND id COLLATE BINARY > ?)`
    : "";
  return {
    sql: `SELECT id, session_id, seq, role, content, timestamp,
      selected_text, tool_calls, tool_call_id, streaming_state,
      api_only, is_system_notice, quoted_messages, search_index_version
    FROM messages
    ${cursorPredicate}
    ORDER BY search_index_version ASC, id COLLATE BINARY ASC
    LIMIT ?`,
    params: cursor
      ? [cursor.searchIndexVersion, cursor.searchIndexVersion, cursor.id, limit]
      : [limit],
  };
}

function buildSourceSessionMessagePageSql(
  sessionId: string,
  limit: number,
  targetVersion: number | undefined,
  cursor?: { searchIndexVersion: number; id: string },
): BoundSearchSql {
  const versionPredicate =
    targetVersion === undefined ? "" : "AND search_index_version < ?";
  const cursorPredicate = cursor
    ? `AND (
        search_index_version > ?
        OR (search_index_version = ? AND id COLLATE BINARY > ?)
      )`
    : "";
  const params: unknown[] = [sessionId];
  if (targetVersion !== undefined) params.push(targetVersion);
  if (cursor) {
    params.push(
      cursor.searchIndexVersion,
      cursor.searchIndexVersion,
      cursor.id,
    );
  }
  params.push(limit);
  return {
    sql: `SELECT id, session_id, seq, role, content, timestamp,
      selected_text, tool_calls, tool_call_id, streaming_state,
      api_only, is_system_notice, quoted_messages, search_index_version
    FROM messages
    WHERE session_id = ?
      ${versionPredicate}
      ${cursorPredicate}
    ORDER BY search_index_version ASC, id COLLATE BINARY ASC
    LIMIT ?`,
    params,
  };
}

export function buildLowerVersionSessionMessagePageSql(
  targetVersion: number,
  sessionId: string,
  limit: number,
  cursor?: { searchIndexVersion: number; id: string },
): BoundSearchSql {
  return buildSourceSessionMessagePageSql(
    sessionId,
    limit,
    targetVersion,
    cursor,
  );
}

export function buildAllSourceSessionMessagePageSql(
  sessionId: string,
  limit: number,
  cursor?: { searchIndexVersion: number; id: string },
): BoundSearchSql {
  return buildSourceSessionMessagePageSql(sessionId, limit, undefined, cursor);
}
