// Fast drop-in for make.fun's csv-reader 1.0.0.
//
// Same answer for every {text, header} input: {columns, rows, errors}.
// Written from scratch against the reference's behaviour: a U+FEFF at the
// start is dropped; records end at LF or CRLF; blank lines are no records;
// a CR outside quotes that is not followed by LF is dropped (stray_cr); a
// field opening with a quote runs to the next non-doubled quote ("" is one
// quote, CRLF or a lone CR inside becomes LF); text after the closing quote
// up to the next comma or line break is appended as-is (quote_junk when
// anything was appended); a quote that never closes is literal and the rest
// is re-read as unquoted (unterminated_quote); quotes inside unquoted fields
// are literal; fields stay strings; short rows are padded (short_row) and
// long rows cut (long_row) to the first record's width.
//
// Speed comes from never walking the text a character at a time. Each record
// remembers where its line ends (one indexOf('\n') per record, reused by
// every field in it); an unquoted field is one slice between that line end
// and the next comma, checked for a stray CR on the slice itself (a search
// bounded by the field, never across the file); a quoted field is one slice
// between indexOf('"') hits. Only the rare broken pieces (a stray CR,
// doubled quotes, a line break inside quotes, junk after a closing quote)
// go through a slower segment path. No state is kept between calls and
// nothing is imported.

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** One CSV input's answer. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on, and its index in rows
  // (null while the header is still unread). Field errors use these, not
  // the live line number.
  let recordLine = 1;
  let recordRow = null;

  // The first LF at or after the position this was last worked out from,
  // or -1 when there is none ahead. It stays true while pos only moves
  // forward: a line end at or after pos is the first LF at or after pos.
  let lineEnd = -1;
  let lineEndValid = false;

  // A quoted field's content, already sliced: CRLF and lone CRs in it
  // become LF, and `line` advances past every line break it holds (a CRLF
  // counts once).
  function fixRaw(raw) {
    let breaks = 0;
    let i = raw.indexOf('\n');
    while (i !== -1) {
      breaks += 1;
      i = raw.indexOf('\n', i + 1);
    }
    let hasCR = false;
    i = raw.indexOf('\r');
    while (i !== -1) {
      hasCR = true;
      breaks += 1;
      if (raw.charCodeAt(i + 1) === 10) breaks -= 1;
      i = raw.indexOf('\r', i + 1);
    }
    line += breaks;
    return hasCR ? raw.replace(/\r\n?/g, '\n') : raw;
  }

  // Reads unquoted characters from pos onto `prefix`, up to the next comma
  // or line break. A CR not followed by LF is dropped (stray_cr). Returns
  // the field, how it ended, and how many characters were kept (`added`:
  // the junk check after a closing quote needs it). Only used for junk
  // after a closing quote and for fields holding a stray CR; the common
  // unquoted field is read inline in the record loop below.
  function readUnquoted(prefix) {
    if (!lineEndValid || (lineEnd !== -1 && lineEnd < pos)) {
      lineEnd = text.indexOf('\n', pos);
      lineEndValid = true;
    }
    const ci = text.indexOf(',', pos);
    let endKind;
    let endPos;
    if (ci !== -1 && (lineEnd === -1 || ci < lineEnd)) {
      endKind = COMMA;
      endPos = ci;
    } else if (lineEnd !== -1) {
      endKind = LINE_BREAK;
      endPos = lineEnd;
    } else {
      endKind = END;
      endPos = n;
    }
    const bodyEnd =
      endKind === LINE_BREAK && endPos > pos && text.charCodeAt(endPos - 1) === 13 ? endPos - 1 : endPos;
    const s = text.slice(pos, bodyEnd);
    if (s.indexOf('\r') !== -1) {
      // A stray CR hides inside the field: walk it in spans, dropping
      // each lone CR and recording it, until a comma, a line break or
      // the end of the text.
      let value = prefix;
      let added = 0;
      while (pos < n) {
        const c = text.charCodeAt(pos);
        if (c === 44) {
          pos += 1;
          return { value, ended: COMMA, added };
        }
        if (c === 10) {
          pos += 1;
          line += 1;
          return { value, ended: LINE_BREAK, added };
        }
        if (c === 13) {
          if (pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
            pos += 2;
            line += 1;
            return { value, ended: LINE_BREAK, added };
          }
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          pos += 1;
          continue;
        }
        const c2 = text.indexOf(',', pos);
        const n2 = text.indexOf('\n', pos);
        const r2 = text.indexOf('\r', pos);
        let stop = -1;
        if (c2 !== -1) stop = c2;
        if (n2 !== -1 && (stop === -1 || n2 < stop)) stop = n2;
        if (r2 !== -1 && (stop === -1 || r2 < stop)) stop = r2;
        if (stop === -1) {
          const tail = text.slice(pos);
          value += tail;
          added += tail.length;
          pos = n;
          return { value, ended: END, added };
        }
        const span = text.slice(pos, stop);
        value += span;
        added += span.length;
        pos = stop;
      }
      return { value, ended: END, added };
    }
    if (endKind === COMMA) {
      pos = endPos + 1;
      return { value: prefix + s, ended: COMMA, added: s.length };
    }
    if (endKind === LINE_BREAK) {
      pos = endPos + 1;
      line += 1;
      return { value: prefix + s, ended: LINE_BREAK, added: s.length };
    }
    pos = n;
    return { value: prefix + s, ended: END, added: s.length };
  }

  // What follows a quoted field's closing quote: a comma, a line break,
  // the end of the text, or junk scanned as unquoted (quote_junk when
  // anything was appended; a lone CR there is a stray_cr first).
  function finishQuoted(value) {
    if (pos >= n) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  // Reads a quoted field whose opening quote is at `open`, when the first
  // quote found after it is doubled, or the field holds a line break, or
  // it never closes.
  function readQuotedSlow(open, openLine) {
    let value = '';
    let search = open + 1;
    for (;;) {
      const q = text.indexOf('"', search);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted, from the quote's own line.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        value += fixRaw(text.slice(search, q)) + '"';
        search = q + 2;
        continue;
      }
      value += fixRaw(text.slice(search, q));
      pos = q + 1;
      return finishQuoted(value);
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let value = '';
    let ended = COMMA;
    let quoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const open = pos;
        const q = text.indexOf('"', pos + 1);
        if (q !== -1 && text.charCodeAt(q + 1) !== 34) {
          // The next quote closes the field; its content is one slice.
          const raw = text.slice(open + 1, q);
          value = raw.indexOf('\n') === -1 && raw.indexOf('\r') === -1 ? raw : fixRaw(raw);
          pos = q + 1;
          const done = finishQuoted(value);
          value = done.value;
          ended = done.ended;
        } else {
          const done = readQuotedSlow(open, line);
          value = done.value;
          ended = done.ended;
        }
      } else {
        quoted = false;
        if (!lineEndValid || (lineEnd !== -1 && lineEnd < pos)) {
          lineEnd = text.indexOf('\n', pos);
          lineEndValid = true;
        }
        const ci = text.indexOf(',', pos);
        let endKind;
        let endPos;
        if (ci !== -1 && (lineEnd === -1 || ci < lineEnd)) {
          endKind = COMMA;
          endPos = ci;
        } else if (lineEnd !== -1) {
          endKind = LINE_BREAK;
          endPos = lineEnd;
        } else {
          endKind = END;
          endPos = n;
        }
        const bodyEnd =
          endKind === LINE_BREAK && endPos > pos && text.charCodeAt(endPos - 1) === 13 ? endPos - 1 : endPos;
        const s = text.slice(pos, bodyEnd);
        if (s.indexOf('\r') !== -1) {
          const done = readUnquoted('');
          value = done.value;
          ended = done.ended;
        } else if (endKind === COMMA) {
          value = s;
          pos = endPos + 1;
          ended = COMMA;
        } else if (endKind === LINE_BREAK) {
          value = s;
          pos = endPos + 1;
          line += 1;
          ended = LINE_BREAK;
        } else {
          value = s;
          pos = n;
          ended = END;
        }
      }
      fields.push(value);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
