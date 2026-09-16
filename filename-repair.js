'use strict';
// Filenames that were read as Latin-1 when they were really UTF-8 bytes.
//
// A browser serialises a multipart filename as the name's UTF-8 bytes (the HTML
// spec requires it), and the parser under multer — busboy — handed those bytes
// to its Latin-1 decoder unless told otherwise. That decoder is
// `Buffer#latin1Slice`, which is TRUE ISO-8859-1: byte 0xE6 becomes U+00E6, and
// byte 0x97 becomes the C1 control U+0097. So "日本語" was stored as the
// ISO-8859-1 reading of its own UTF-8 bytes — "æ\u0097¥æ\u009C¬èª\u009E", four
// visible characters and four invisible ones — and every non-ASCII title reached
// the reader as a ladder of accents.
//
// DO NOT "fix" this with `new TextDecoder('latin1')`: that label means
// WINDOWS-1252 in the WHATWG Encoding Standard, where 0x97 is an em dash and 0x8A
// is "Š". Reversing through cp1252 changes nothing for a name spelled
// `latin1Slice` and corrupts the ones it does touch — which is exactly how an
// earlier cut of this module reported "0 repaired" against a table full of
// mojibake.
//
// New uploads are decoded as UTF-8 at the boundary (see uploader() in server.js).
// This module exists for the two things that boundary fix cannot reach — the rows
// already in the database (the boot repair in server.js), and a client that still
// hands over Latin-1 bytes.
//
// The reversal is EXACT rather than a guess about "looks like mojibake": every
// character is written back as its own code point and the result is only accepted
// when those bytes are valid UTF-8 that re-encodes to themselves. A genuinely
// Latin-1 name ("Café-résumé.txt": é is a lone 0xE9) is therefore left exactly as
// it is, and a correct name is a no-op (its bytes are not valid UTF-8 to begin
// with — a CJK character is above U+00FF and cannot even be spelled this way).
// The one case it cannot tell apart is a name that ALREADY spells a UTF-8
// sequence in Latin-1 characters — a file literally called "Ã©" — which is
// repaired to "é"; that is the price of recovering the rest, and it is the same
// trade every browser-side fix for this bug makes.

// The name's characters as the bytes this decoder would have spelled them, or
// null when some character cannot have come from it at all (anything above
// U+00FF) — in which case the name is already correct and must not be touched.
function latin1Bytes(s) {
  const out = Buffer.allocUnsafe(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) return null;
    out[i] = c;
  }
  return out;
}

// Repair one name. Returns the name unchanged when there is nothing exact to
// recover, so it is always safe to call on every name an upload hands over.
function repairLatin1Name(value) {
  const s = String(value == null ? '' : value);
  // Cheap gate first: only a UTF-8 lead byte can begin a sequence, and byte for
  // byte those are exactly U+00C2-U+00F4 here. Pure ASCII and honest Latin-1
  // names (é, ü, ñ, °…) never reach the buffer.
  if (!/[\u00c2-\u00f4]/.test(s)) return s;
  const bytes = latin1Bytes(s);
  if (!bytes) return s;
  const fixed = bytes.toString('utf8');
  // Node substitutes U+FFFD for malformed input, and re-encoding that can never
  // reproduce the original bytes — so this one compare is the whole validity
  // test, and an invalid reading is left alone instead of becoming garbage.
  if (Buffer.compare(Buffer.from(fixed, 'utf8'), bytes) !== 0) return s;
  return fixed;
}

module.exports = { repairLatin1Name, latin1Bytes };
