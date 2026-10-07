#!/usr/bin/env python3
"""Builds tests/fixtures/plan.xlsx, a small workbook with the structures the
.xlsx reader must handle (as Excel writes them): two sheets (the first has no
task table), title rows above the header, shared strings including rich text,
an inline string, built-in and custom date formats, a percent format, a formula
with a cached value, and skipped columns. Run: python3 tests/fixtures/make_xlsx.py"""
import zipfile, datetime, os

def serial(y, m, d):  # Excel 1900 date system
    return (datetime.date(y, m, d) - datetime.date(1899, 12, 30)).days

NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
shared = ['Notes about this workbook', 'Senior design schedule', 'WBS', 'Task', 'Duration', 'Depends on', '% complete',
          'Owner', 'Pinned start', 'Start', 'Planning', 'Define requirements', 'Sam', 'Build & test', 'Fabricate chassis']
idx = {s: i for i, s in enumerate(shared)}
def ss(ref, s): return f'<c r="{ref}" t="s"><v>{idx[s]}</v></c>'
def num(ref, v, style=0):
    st = ' s="%d"' % style if style else ''
    return f'<c r="{ref}"{st}><v>{v}</v></c>'

sst = ''.join(f'<si><t>{s.replace("&", "&amp;")}</t></si>' for s in shared[:-1])
# Last shared string as rich text (two runs), as Excel writes partially bold text
sst += '<si><r><rPr><b/></rPr><t>Fabricate </t></r><r><t>chassis</t></r></si>'

styles = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet {NS}><numFmts count="2"><numFmt numFmtId="164" formatCode="[$-409]mmm d, yyyy"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts>
<cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="9" applyNumberFormat="1"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="165" applyNumberFormat="1"/></cellXfs></styleSheet>'''

notes = f'<worksheet {NS}><sheetData><row r="1">{ss("A1", "Notes about this workbook")}</row></sheetData></worksheet>'
rows = [
    f'<row r="1">{ss("A1", "Senior design schedule")}</row>',
    # row 2 empty, header in row 3; column D left empty on purpose
    f'<row r="3">{ss("A3", "WBS")}{ss("B3", "Task")}{ss("C3", "Duration")}{ss("E3", "Depends on")}{ss("F3", "% complete")}{ss("G3", "Owner")}{ss("H3", "Pinned start")}{ss("I3", "Start")}</row>',
    f'<row r="4"><c r="A4" t="str"><v>1</v></c>{ss("B4", "Planning")}{num("I4", serial(2026, 10, 5), 3)}</row>',
    f'<row r="5"><c r="A5" t="str"><v>1.1</v></c>{ss("B5", "Define requirements")}<c r="C5"><f>2+3</f><v>5</v></c>{num("F5", 0.4, 2)}{ss("G5", "Sam")}</row>',
    f'<row r="6"><c r="A6" t="str"><v>1.2</v></c><c r="B6" t="inlineStr"><is><t>Concept selection</t></is></c>{num("C6", 3)}<c r="E6" t="str"><v>2SS</v></c>{num("F6", 0.125, 4)}{num("H6", serial(2026, 10, 7), 1)}</row>',
    f'<row r="7"><c r="A7" t="str"><v>2</v></c>{ss("B7", "Build & test")}</row>',
    f'<row r="8"><c r="A8" t="str"><v>2.1</v></c>{ss("B8", "Fabricate chassis")}{num("C8", 8)}<c r="E8" t="str"><v>3</v></c><c r="F8" t="b"><v>0</v></c></row>',
]
sched = f'<worksheet {NS}><sheetData>{"".join(rows)}</sheetData></worksheet>'

files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    'xl/workbook.xml': f'<?xml version="1.0" encoding="UTF-8"?><workbook {NS}><workbookPr/><sheets><sheet name="Notes" sheetId="1" r:id="rId1"/><sheet name="Schedule" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': f'<?xml version="1.0" encoding="UTF-8"?><sst {NS} count="{len(shared)}">{sst}</sst>',
    'xl/styles.xml': styles,
    'xl/worksheets/sheet1.xml': notes,
    'xl/worksheets/sheet2.xml': sched,
}
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'plan.xlsx')
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for name, data in files.items():
        z.writestr(name, data)
print('wrote', out)
