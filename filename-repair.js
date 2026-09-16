'use strict';
// Filenames that were read as Latin-1 when they were really UTF-8 bytes.
//
// A browser serialises a multipart filename as the name's UTF-8 bytes (the HTML
// spec requires it). Busboy — the parser under multer — used to hand those bytes
// to a Latin-1 decoder unless told otherwise, and the WHATWG Encoding Standard
// defines the "latin1" label as WINDOWS-1252, not ISO-8859-1. So every
// non-ASCII filename was stored as the cp1252 spelling of its own UTF-8 bytes:
// "中文" arrived as "ä¸æ–‡", "العربية" as "Ø§Ù„Ø¹Ø±Ø¨ÙŠØ©", and the reader got a
// ladder of accents where the title should be. New uploads are decoded as UTF-8
// at the boundary (see uploader() in server.js); this module reverses the old
// reading for the two things that boundary fix cannot reach — the rows already
// in the database, and a client that still sends Latin-1 bytes.
//
// The reversal is EXACT rather than a guess about "looks like mojibake": the
// string is written back to the bytes cp1252 would have produced and is only
// accepted when those bytes are valid UTF-8 that re-encodes to themselves. A
// genuinely Latin-1 name ("Café-résumé.txt": é is a lone 0xE9) is therefore left
// exactly as it is, and a correct name is a no-op (its cp1252 reading is not
// valid UTF-8). The one case it cannot tell apart is a name that ALREADY spells
// a UTF-8 sequence in cp1252 characters — a file literally called "Ã©" — which
// is repaired to "é"; that is the price of recovering the rest, and it is the
// same trade every browser-side fix for this bug makes.

// The exact inverse of the decoder busboy used, derived from the decoder itself
// rather than hand-typed from the cp1252 table (a typo there would silently
// corrupt names). Byte 0x80-0xFF -> the character WHATWG cp1252 maps it to;
// 0x81, 0x8D, 0x8F, 0x90 and 0x9D are undefined in cp1252 and decode to their
// own C1 control, which is why the range is walked instead of tabulated.
const BYTE_FOR_CHAR = (() => {
  const dec = new TextDecoder('latin1'); // WHATWG: windows-1252
  const m = new Map();
  for (let b = 0x00; b <= 0xff; b++) {
    const ch = dec.decode(Buffer.from([b]));
    if (!m.has(ch)) m.set(ch, b);
  }
  return m;
})();

// The name's characters as the bytes cp1252 would have spelled them, or null
// when some character cannot have come from cp1252 at all (an emoji, a CJK
// character that survived correctly, a lone surrogate) — in which case the name
// is already fine and must not be touched.
function cp1252Bytes(s) {
  const out = Buffer.allocUnsafe(s.length);
  for (let i = 0; i < s.length; i++) {
    const b = BYTE_FOR_CHAR.get(s[i]);
    if (b === undefined) return null;
    out[i] = b;
  }
  return out;
}

// Repair one name. Returns the name unchanged when there is nothing exact to
// recover, so it is always safe to call on every name an upload hands over.
function repairLatin1Name(value) {
  const s = String(value == null ? '' : value);
  // Cheap gate first: only a UTF-8 lead byte can begin a sequence, and in
  // cp1252 those are exactly U+00C2-U+00F4. Pure ASCII and honest Latin-1 names
  // (é, ü, ñ, °…) never reach the buffer.
  if (!/[\u00c2-\u00f4]/.test(s)) return s;
  const bytes = cp1252Bytes(s);
  if (!bytes) return s;
  const fixed = bytes.toString('utf8');
  // Node substitutes U+FFFD for malformed input, and re-encoding that can never
  // reproduce the original bytes — so this one compare is the whole validity
  // test, and an invalid reading is left alone instead of becoming garbage.
  if (Buffer.compare(Buffer.from(fixed, 'utf8'), bytes) !== 0) return s;
  return fixed;
}

module.exports = { repairLatin1Name, cp1252Bytes };
