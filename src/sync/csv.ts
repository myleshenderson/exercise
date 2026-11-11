/** The one RFC 4180 parser the sync adapters share (AI-663). Pure: no I/O. */

/**
 * RFC 4180 records: quoted fields may hold commas, doubled quotes and newlines; CRLF, LF or a lone
 * CR ends a record; a leading BOM is dropped. A blank line (one field, empty after trimming) is not
 * a record.
 */
export function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    if (!(record.length === 1 && record[0].trim() === "")) records.push(record);
    record = [];
  };
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") endField();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRecord();
    } else field += c;
  }
  if (field !== "" || record.length > 0) endRecord();
  return records;
}
