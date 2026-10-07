// Minimal reader for Excel workbooks (.xlsx, also what Google Sheets and
// Numbers export). An .xlsx file is a zip archive of XML parts; the browser
// already provides what's needed (DecompressionStream to inflate, DOMParser to
// read XML), so no library is required.
//
// readXlsx(arrayBuffer) -> [{ name, rows: string[][] }] in workbook order.
// Cell values come back as text the CSV importer understands: shared and
// inline strings as-is, numbers as plain numbers, cells formatted as dates as
// YYYY-MM-DD, percentages as 0–100, booleans as TRUE/FALSE. Formulas give
// their last calculated value. Not supported: the old binary .xls format.

const SIG_EOCD = 0x06054b50, SIG_CENTRAL = 0x02014b50, SIG_LOCAL = 0x04034b50;

// ---- zip ----

function readZipEntries(buf) {
  const dv = new DataView(buf);
  // End of central directory: last 22 bytes plus an optional comment
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This file is not an Excel workbook (.xlsx).');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== SIG_CENTRAL) throw new Error('The workbook file is damaged.');
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    entries.set(name, { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readEntry(buf, entries, name) {
  const e = entries.get(name);
  if (!e) return null;
  const dv = new DataView(buf);
  if (dv.getUint32(e.local, true) !== SIG_LOCAL) throw new Error('The workbook file is damaged.');
  const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
  const raw = new Uint8Array(buf, start, e.size);
  let bytes;
  if (e.method === 0) bytes = raw;
  else if (e.method === 8) {
    const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } else throw new Error('The workbook uses a compression this app can’t read.');
  return new TextDecoder().decode(bytes);
}

// ---- XML helpers ----

const parseXML = text => new DOMParser().parseFromString(text, 'application/xml');
// Elements by local name, ignoring namespace prefixes
const all = (node, name) => [...node.getElementsByTagNameNS('*', name)];
const one = (node, name) => all(node, name)[0] || null;
const textOf = node => all(node, 't').map(t => t.textContent).join('');

// ---- number formats ----

// Built-in date/time formats (ECMA-376 18.8.30) and percent formats
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const BUILTIN_PCT = new Set([9, 10]);

function formatKinds(stylesXml) {
  const kinds = []; // per cellXfs index: 'date' | 'pct' | null
  if (!stylesXml) return kinds;
  const doc = parseXML(stylesXml);
  const custom = new Map(all(doc, 'numFmt').map(f => [Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode') || '']));
  const cellXfs = one(doc, 'cellXfs');
  for (const xf of cellXfs ? all(cellXfs, 'xf') : []) {
    const id = Number(xf.getAttribute('numFmtId') || 0);
    let kind = BUILTIN_DATE.has(id) ? 'date' : BUILTIN_PCT.has(id) ? 'pct' : null;
    if (!kind && custom.has(id)) {
      // Ignore quoted text, escapes and [colour]/[locale] sections before looking for d/m/y or %
      const code = custom.get(id).replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '');
      kind = /[dy]|m(?!.*:)/i.test(code) && !/^[hms:.\s0]*$/i.test(code) ? 'date' : code.includes('%') ? 'pct' : null;
    }
    kinds.push(kind);
  }
  return kinds;
}

// Excel serial day number -> YYYY-MM-DD. The 1900 system counts 1900-02-29
// (which never existed), so serials after 59 are one day ahead.
function serialToISO(serial, date1904) {
  const days = Math.floor(serial);
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const adj = !date1904 && days <= 59 ? 1 : 0;
  return new Date(epoch + (days + adj) * 86400000).toISOString().slice(0, 10);
}

function colIndex(ref) {
  const letters = /^[A-Z]+/i.exec(ref || '')?.[0].toUpperCase() || 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

// Trim floating-point noise (0.30000000000000004) without losing real digits
const numText = v => String(Number(Number(v).toPrecision(12)));

// ---- workbook ----

export async function readXlsx(buf) {
  if (new DataView(buf).getUint32(0, true) !== SIG_LOCAL) {
    throw new Error(new Uint8Array(buf, 0, 2).join() === '208,207'
      ? 'This is an old-style Excel file (.xls). In Excel, use File → Save As → Excel Workbook (.xlsx), then open that.'
      : 'This file is not an Excel workbook (.xlsx).');
  }
  const entries = readZipEntries(buf);
  const wbXml = await readEntry(buf, entries, 'xl/workbook.xml');
  if (!wbXml) throw new Error('This file is not an Excel workbook (.xlsx).');
  const wb = parseXML(wbXml);
  const date1904 = ['1', 'true'].includes(one(wb, 'workbookPr')?.getAttribute('date1904'));
  const relsXml = await readEntry(buf, entries, 'xl/_rels/workbook.xml.rels');
  const rels = new Map(relsXml ? all(parseXML(relsXml), 'Relationship').map(r => [r.getAttribute('Id'), r.getAttribute('Target')]) : []);
  const ssXml = await readEntry(buf, entries, 'xl/sharedStrings.xml');
  const shared = ssXml ? all(parseXML(ssXml), 'si').map(textOf) : [];
  const kinds = formatKinds(await readEntry(buf, entries, 'xl/styles.xml'));

  const sheets = [];
  for (const s of all(wb, 'sheet')) {
    const rid = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || s.getAttribute('r:id');
    let target = rels.get(rid) || '';
    target = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = await readEntry(buf, entries, target);
    if (!xml) continue;
    const rows = [];
    for (const row of all(parseXML(xml), 'row')) {
      const r = Number(row.getAttribute('r')) - 1;
      const out = [];
      for (const c of all(row, 'c')) {
        const t = c.getAttribute('t'), v = one(c, 'v')?.textContent ?? '';
        const kind = kinds[Number(c.getAttribute('s') || 0)];
        let val;
        if (t === 's') val = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') val = textOf(one(c, 'is') || c);
        else if (t === 'str' || t === 'e') val = v;
        else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else if (v === '') val = '';
        else if (kind === 'date') val = serialToISO(Number(v), date1904);
        else if (kind === 'pct') val = numText(Number(v) * 100);
        else val = numText(v);
        out[colIndex(c.getAttribute('r'))] = val;
      }
      rows[Number.isFinite(r) && r >= 0 ? r : rows.length] = Array.from(out, x => x ?? '');
    }
    sheets.push({ name: s.getAttribute('name') || `Sheet${sheets.length + 1}`, rows: Array.from(rows, x => x ?? []) });
  }
  return sheets;
}

// ---- writing (for the template workbook) ----
//
// writeXlsx(rows, { sheetName, widths }) -> Uint8Array of an .xlsx file with
// one sheet. Numbers become number cells, everything else text; the first row
// is bold and stays visible when scrolling. Files are stored uncompressed,
// which every spreadsheet program accepts and keeps this short.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStored(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  for (const [name, text] of files) {
    const nameB = enc.encode(name), data = enc.encode(text), crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, SIG_LOCAL, true); local.setUint16(4, 20, true); local.setUint16(8, 0, true);
    local.setUint16(12, DOS_DATE, true); local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, nameB.length, true);
    parts.push(new Uint8Array(local.buffer), nameB, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, SIG_CENTRAL, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true);
    cen.setUint16(14, DOS_DATE, true); cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true); cen.setUint16(28, nameB.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, SIG_EOCD, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const b of all) { out.set(b, p); p += b.length; }
  return out;
}

const xmlEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const colName = i => { let s = ''; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

export function writeXlsx(rows, { sheetName = 'Sheet1', widths = [] } = {}) {
  const sheetRows = rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => {
    if (v === '' || v === null || v === undefined) return '';
    const ref = `${colName(j)}${i + 1}`, style = i === 0 ? ' s="1"' : '';
    return typeof v === 'number'
      ? `<c r="${ref}"${style}><v>${v}</v></c>`
      : `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const cols = widths.length ? `<cols>${widths.map((w, j) => `<col min="${j + 1}" max="${j + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  return zipStored([
    ['[Content_Types].xml', `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '</Types>'],
    ['_rels/.rels', `${head}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${head}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="${xmlEsc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${head}<Relationships xmlns="${PKG_REL}">`
      + `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>`
      + `<Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `${head}<styleSheet xmlns="${MAIN}">`
      + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
      + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
    ['xl/worksheets/sheet1.xml', `${head}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">`
      + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      + `${cols}<sheetData>${sheetRows}</sheetData></worksheet>`],
  ]);
}

export const _internal = { serialToISO, colIndex, formatKinds, crc32, colName };
