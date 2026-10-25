/**
 * Ядро генерации SQL (PostgreSQL-диалект).
 * Работает полностью на клиенте (Next.js) — Go не участвует в генерации.
 */

/** Экранирование строкового литерала: обрамление в '...' + удвоение апострофов */
export function pgQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

/* ---------- Подсветка синтаксиса для предпросмотра ---------- */

const KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET",
  "DELETE", "CREATE", "TABLE", "ALTER", "DROP", "JOIN", "LEFT", "RIGHT",
  "INNER", "OUTER", "ON", "AND", "OR", "NOT", "NULL", "TRUE", "FALSE",
  "LIKE", "IN", "AS", "ORDER", "BY", "GROUP", "HAVING", "LIMIT", "OFFSET",
  "RETURNING", "DEFAULT", "UNIQUE", "PRIMARY", "KEY", "FOREIGN",
  "REFERENCES", "BEGIN", "COMMIT", "ROLLBACK", "CASE", "WHEN", "THEN",
  "ELSE", "END", "TEMP",
]);

const TOKEN_RE =
  /(--[^\n]*)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|([\p{L}_]+)/gu;

function escHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Возвращает HTML с расставленными span-токенами (вход экранируется) */
export function highlightSQL(sql) {
  let out = "";
  let last = 0;
  for (const m of sql.matchAll(TOKEN_RE)) {
    const i = m.index;
    out += escHtml(sql.slice(last, i));
    const [tok, comment, str, num, word] = m;
    if (comment) {
      out += `<span class="tok-comment">${escHtml(tok)}</span>`;
    } else if (str) {
      out += `<span class="tok-string">${escHtml(tok)}</span>`;
    } else if (num) {
      out += `<span class="tok-number">${escHtml(tok)}</span>`;
    } else if (word && KEYWORDS.has(word.toUpperCase())) {
      out += `<span class="tok-keyword">${escHtml(tok)}</span>`;
    } else {
      out += escHtml(tok);
    }
    last = i + tok.length;
  }
  out += escHtml(sql.slice(last));
  return out;
}
