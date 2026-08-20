import { err, type EngineError } from "./errors.js";

interface ScanResult {
  firstTokenIndex: number;
  hasChainedStatement: boolean;
  hasLimit: boolean;
  lastSemicolonIndex: number; // Position of last top-level semicolon, or -1 if none
}

/**
 * Scans a SQL statement character by character, tracking string literals,
 * identifiers, and comments. Returns analysis needed for validation.
 */
function scanStatement(sql: string): ScanResult {
  let i = 0;
  let firstTokenIndex = -1;
  let hasChainedStatement = false;
  let hasLimit = false;
  let semicolonCount = 0;
  let lastSemicolonIndex = -1;

  while (i < sql.length) {
    const ch = sql[i];

    // Skip whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Line comment: -- to newline
    if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      if (i < sql.length) i++; // skip newline
      continue;
    }

    // Block comment: /* to */
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      if (i < sql.length) i += 2; // skip */
      continue;
    }

    // Single-quoted string: '...' with '' as escaped quote
    if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2; // escaped quote ''
          } else {
            i++; // end of string
            break;
          }
        } else {
          i++;
        }
      }
      continue;
    }

    // Double-quoted identifier: "..." with "" as escaped quote
    if (ch === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2; // escaped quote ""
          } else {
            i++; // end of identifier
            break;
          }
        } else {
          i++;
        }
      }
      continue;
    }

    // Backtick-quoted identifier: `...`
    if (ch === "`") {
      i++;
      while (i < sql.length && sql[i] !== "`") i++;
      if (i < sql.length) i++; // skip closing backtick
      continue;
    }

    // Bracket-quoted identifier: [...]
    if (ch === "[") {
      i++;
      while (i < sql.length && sql[i] !== "]") i++;
      if (i < sql.length) i++; // skip closing bracket
      continue;
    }

    // Semicolon - statement separator (top-level, outside quotes/comments)
    if (ch === ";") {
      semicolonCount++;
      lastSemicolonIndex = i;
      i++;
      continue;
    }

    // Real token found
    if (firstTokenIndex === -1) {
      firstTokenIndex = i;
    }

    // Check if this token is LIMIT
    const restOfStatement = sql.substring(i);
    const wordMatch = restOfStatement.match(/^([a-zA-Z_]\w*)/);
    if (wordMatch && wordMatch[1].toUpperCase() === "LIMIT") {
      hasLimit = true;
    }

    // Skip this token
    if (wordMatch) {
      i += wordMatch[1].length;
    } else {
      i++;
    }
  }

  // Check for statement chaining: more than one semicolon, or real content after semicolon (besides whitespace/comments)
  // We allow one optional trailing semicolon
  if (semicolonCount > 1) {
    hasChainedStatement = true;
  } else if (semicolonCount === 1 && lastSemicolonIndex !== -1) {
    // Check if there's real content after the top-level semicolon (besides whitespace/comments)
    const afterSemicolon = sql.substring(lastSemicolonIndex + 1);
    let j = 0;
    while (j < afterSemicolon.length) {
      const c = afterSemicolon[j];
      if (/\s/.test(c)) {
        j++;
        continue;
      }
      if (c === "-" && afterSemicolon[j + 1] === "-") {
        j += 2;
        while (j < afterSemicolon.length && afterSemicolon[j] !== "\n") j++;
        continue;
      }
      if (c === "/" && afterSemicolon[j + 1] === "*") {
        j += 2;
        while (j < afterSemicolon.length && !(afterSemicolon[j] === "*" && afterSemicolon[j + 1] === "/")) j++;
        j += 2;
        continue;
      }
      // Found real content after semicolon
      hasChainedStatement = true;
      break;
    }
  }

  return { firstTokenIndex, hasChainedStatement, hasLimit, lastSemicolonIndex };
}

/**
 * run_sql executes through prepare(), which ignores everything after the first
 * semicolon. exec() runs every statement and would let "SELECT 1; VACUUM INTO"
 * slip past a leading-statement check, so run_sql must never use it. We still
 * reject chained statements outright, because a query that relies on the tail
 * being dropped is a query whose author misunderstood what will run.
 */
export function checkStatement(sql: string): EngineError | null {
  const scan = scanStatement(sql);

  // Reject chained statements
  if (scan.hasChainedStatement) {
    return err("invalid_argument", "Only a single SQL statement is allowed", { detail: sql });
  }

  // Extract first keyword
  if (scan.firstTokenIndex === -1) {
    return null; // Empty or only comments/whitespace - allow
  }

  const rest = sql.substring(scan.firstTokenIndex);
  const keywordMatch = rest.match(/^([a-zA-Z_]\w*)/);
  if (!keywordMatch) return null;

  const keyword = keywordMatch[1].toUpperCase();

  // Reject VACUUM, ATTACH, DETACH
  if (keyword === "VACUUM" || keyword === "ATTACH" || keyword === "DETACH") {
    return err("invalid_argument", "VACUUM, ATTACH and DETACH are not permitted", { detail: sql });
  }

  // Check PRAGMA statements
  if (keyword === "PRAGMA") {
    // Find the pragma name - skip past PRAGMA keyword and whitespace
    let pragmaStart = scan.firstTokenIndex + 6; // length of "PRAGMA"
    while (pragmaStart < sql.length && /\s/.test(sql[pragmaStart])) pragmaStart++;

    // Skip optional schema qualifier (main., temp., side., engine.)
    if (pragmaStart < sql.length) {
      const schemaMatch = sql.substring(pragmaStart).match(/^(main|temp|side|engine)\./i);
      if (schemaMatch) {
        pragmaStart += schemaMatch[0].length;
      }
    }

    // Extract pragma name
    const pragmaNameMatch = sql.substring(pragmaStart).match(/^([a-zA-Z_]\w*)/);
    if (!pragmaNameMatch) return null;

    const pragmaName = pragmaNameMatch[1].toUpperCase();
    const allowedPragmas = ["TABLE_INFO", "TABLE_LIST", "INDEX_LIST", "INDEX_INFO", "FOREIGN_KEY_LIST"];

    if (!allowedPragmas.includes(pragmaName)) {
      return err("invalid_argument", "Only read-only PRAGMA introspection is permitted", { detail: sql });
    }
  }

  return null;
}

export function enforceLimit(sql: string, limit: number): string {
  const scan = scanStatement(sql);

  // Extract first keyword
  if (scan.firstTokenIndex === -1) {
    return sql; // Empty or only comments/whitespace - return unchanged
  }

  const rest = sql.substring(scan.firstTokenIndex);
  const keywordMatch = rest.match(/^([a-zA-Z_]\w*)/);
  if (!keywordMatch) return sql;

  const keyword = keywordMatch[1].toUpperCase();

  // Only append LIMIT for SELECT or WITH statements without LIMIT
  if ((keyword === "SELECT" || keyword === "WITH") && !scan.hasLimit) {
    const trimmed = sql.trim().replace(/;\s*$/, "");
    return `${trimmed} LIMIT ${limit}`;
  }

  return sql;
}
