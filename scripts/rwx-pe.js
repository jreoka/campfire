// A synthetic PE whose every section is writable AND executable, and whose
// section names are deliberately non-standard.
//
// Harbin's tier-1 precision anchors include exactly this shape (a non-standard
// PE layout where every section is simultaneously writable and executable),
// because nothing legitimate ships that way. It is therefore a *deterministic*
// positive control for the detection path that is not a virus signature — so a
// test or an acceptance check can prove "this engine really detects" without
// writing EICAR to disk, where a host-side antivirus would quarantine it (see
// the EICAR note in scripts/verify-harbin.js).
//
// The layout is the minimum Harbin's parser accepts: DOS header with e_lfanew,
// PE\0\0, a COFF header, a 96-byte PE32 optional header (the parser's floor),
// and a two-entry section table.
'use strict';

const SECTIONS = [
  { name: '.cfg0', virtualAddress: 0x1000, rawSize: 0x200 },
  { name: '.cfg1', virtualAddress: 0x2000, rawSize: 0x200 },
];

const OPT_LEN = 96;         // PE32 optional header, the parser's minimum
const OPT_OFF = 0x58;       // e_lfanew(0x40) + "PE\0\0"(4) + COFF(20)
const SEC_OFF = OPT_OFF + OPT_LEN;
const SECTION_CHARS = 0xe0000020; // CNT_CODE | MEM_EXECUTE | MEM_READ | MEM_WRITE

function rwxPe() {
  const firstRaw = 0x200;
  const total = firstRaw + SECTIONS.reduce((n, s) => n + s.rawSize, 0);
  const b = Buffer.alloc(total);

  b.write('MZ', 0, 'latin1');            // DOS magic
  b.writeUInt32LE(0x40, 0x3C);           // e_lfanew
  b.writeUInt32LE(0x00004550, 0x40);     // "PE\0\0"

  const coff = 0x44;
  b.writeUInt16LE(0x014c, coff);         // machine: i386
  b.writeUInt16LE(SECTIONS.length, coff + 2);
  b.writeUInt32LE(0x60000000, coff + 4); // timestamp
  b.writeUInt16LE(OPT_LEN, coff + 16);   // size of the optional header
  b.writeUInt16LE(0x0102, coff + 18);    // EXECUTABLE_IMAGE | 32BIT_MACHINE

  b.writeUInt16LE(0x10b, OPT_OFF);       // magic: PE32
  b.writeUInt32LE(0x1000, OPT_OFF + 32); // section alignment
  b.writeUInt32LE(0x200, OPT_OFF + 36);  // file alignment

  let raw = firstRaw;
  SECTIONS.forEach((s, i) => {
    const at = SEC_OFF + i * 40;
    b.write(s.name, at, 'latin1');
    b.writeUInt32LE(s.rawSize, at + 8);        // virtual size
    b.writeUInt32LE(s.virtualAddress, at + 12);
    b.writeUInt32LE(s.rawSize, at + 16);       // size of raw data
    b.writeUInt32LE(raw, at + 20);             // pointer to raw data
    b.writeUInt32LE(SECTION_CHARS, at + 36);   // characteristics
    for (let k = 0; k < s.rawSize; k++) b[raw + k] = (i * 7 + k * 31) & 0xff;
    raw += s.rawSize;
  });

  return b;
}

module.exports = { rwxPe };
