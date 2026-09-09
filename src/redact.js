/**
 * Secret scrubbing for memory text that is about to enter model context.
 *
 * Claude Code's memory files are working notes, and this machine's notes do
 * contain live credentials (verified 2026-09-09: a session token, two
 * passwords, and a JDBC DSN with inline credentials across 400 memory files).
 * DeepSeek Harness sends assembled context to a model provider, which is a
 * different trust boundary from the one those notes were written for. Every
 * byte this plugin contributes therefore passes through {@link redactText}
 * first.
 *
 * The policy is deliberately conservative: a false positive costs one masked
 * line, a false negative ships a credential to a third party.
 *
 * @module dsh-claude-memory/redact
 */

/** Marker inserted in place of a scrubbed value. */
export const REDACTION_MARK = '[REDACTED]'

/**
 * Ordered redaction rules. `group` selects which capture to replace: 0 means the
 * whole match, otherwise the numbered capture group.
 */
const RULES = [
  // Well-known provider key shapes.
  { kind: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, group: 0 },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, group: 0 },
  { kind: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{16,}\b/g, group: 0 },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, group: 0 },
  { kind: 'aws-key-id', re: /\bAKIA[0-9A-Z]{16}\b/g, group: 0 },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, group: 0 },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, group: 0 },

  // Authorization headers and PEM blocks.
  { kind: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/g, group: 0 },
  {
    kind: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    group: 0,
  },

  // `password: hunter2` / `pwd = \`abc123\`` — value must be 8+ non-space chars
  // and contain a digit or be 12+ chars, which keeps prose like
  // "password: stored in 1password" from being masked.
  {
    kind: 'password',
    re: /(?<=\b(?:password|passwd|pwd)\s*[:=]\s*)[`'"]?([^\s`'"\n]{8,})/gi,
    group: 1,
    requireEntropy: true,
  },

  // `token: ...` / `api_key = ...` / `secret: ...` with a long opaque value.
  {
    kind: 'api-secret',
    re: /(?<=\b(?:token|api[_-]?key|apikey|secret|access[_-]?key|client[_-]?secret)\s*[:=]\s*)[`'"]?([A-Za-z0-9._\-+/]{12,})/gi,
    group: 1,
  },

  // Connection strings with inline credentials.
  { kind: 'dsn', re: /\b(?:jdbc:)?[a-z][a-z0-9+.-]*:\/\/[^\s:'"@/]+:[^\s:'"@/]+@[^\s'"]+/gi, group: 0 },

  // Long opaque hex blobs (tokens, hashes used as credentials).
  { kind: 'long-hex', re: /\b[0-9a-f]{32,}\b/g, group: 0 },
]

/** Does a candidate value look random enough to be a real secret? */
function looksSecret(value) {
  if (value.length >= 12) return true
  return /[0-9]/.test(value) && /[A-Za-z]/.test(value)
}

/**
 * Scrub credential-shaped substrings from text.
 *
 * @param {string} text - raw text.
 * @param {{mode?: 'on'|'report'|'off'}} [options] - `report` counts hits without
 *   altering the text; `off` returns the input untouched.
 * @returns {{text: string, hits: Record<string, number>, total: number}} scrubbed text and per-rule hit counts.
 */
export function redactText(text, options = {}) {
  const mode = options.mode ?? 'on'
  const hits = {}
  if (mode === 'off' || typeof text !== 'string' || text.length === 0) {
    return { text, hits, total: 0 }
  }

  let output = text
  let total = 0

  for (const rule of RULES) {
    let count = 0
    output = output.replace(rule.re, (match, ...rest) => {
      // `rest` ends with (offset, string, groups?) for regex replacers.
      const captured = rule.group === 0 ? match : rest[rule.group - 1]
      if (typeof captured !== 'string' || captured.length === 0) return match
      if (rule.requireEntropy === true && !looksSecret(captured)) return match

      count += 1
      if (mode === 'report') return match
      if (rule.group === 0) return REDACTION_MARK
      return match.replace(captured, REDACTION_MARK)
    })
    if (count > 0) {
      hits[rule.kind] = count
      total += count
    }
  }

  return { text: output, hits, total }
}

/**
 * One-line human summary of redaction hits, or an empty string when clean.
 *
 * @param {Record<string, number>} hits - per-rule counts.
 * @returns {string} summary.
 */
export function describeHits(hits) {
  const parts = Object.entries(hits).map(([kind, n]) => `${kind}×${n}`)
  return parts.join(', ')
}
