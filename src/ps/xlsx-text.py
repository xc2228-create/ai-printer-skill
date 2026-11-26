# Extract the first worksheet of a .xlsx as rows (打印链路 B：保内容，零依赖可用).
# Usage: python xlsx-text.py <in.xlsx>
# Prints one JSON object:
#   {"source":"openpyxl"|"ooxml","sheet":"Sheet1","sheets":[...],
#    "colWidths":[8.43,...],"rows":[["a","b",...],...],"truncated":false}
import datetime
import json
import os
import sys

MAX_ROWS = 2000


def cell_text(value):
    if value is None:
        return ''
    if isinstance(value, bool):
        return 'TRUE' if value else 'FALSE'
    if isinstance(value, float):
        if value.is_integer() and abs(value) < 1e15:
            return str(int(value))
        return ('%.6f' % value).rstrip('0').rstrip('.')
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        if isinstance(value, datetime.datetime) and value.hour == 0 and value.minute == 0 and value.second == 0:
            return value.strftime('%Y-%m-%d')
        if isinstance(value, datetime.date):
            return value.strftime('%Y-%m-%d')
        return value.strftime('%H:%M:%S')
    return str(value)


def trim(rows):
    while rows and all(cell == '' for cell in rows[-1]):
        rows.pop()
    if not rows:
        return rows
    width = max(len(row) for row in rows)
    for row in rows:
        while len(row) < width:
            row.append('')
    while width > 1 and all(row[width - 1] == '' for row in rows):
        for row in rows:
            row.pop()
        width -= 1
    return rows


def via_openpyxl(path):
    import openpyxl
    book = openpyxl.load_workbook(path, data_only=True)
    sheets = [sheet.title for sheet in book.worksheets]
    sheet = book.worksheets[0]
    widths = []
    for letter in 'ABCDEFGHIJKLMNOP':
        dim = sheet.column_dimensions.get(letter)
        widths.append(round(float(dim.width), 2) if dim is not None and dim.width else 0)
    rows = []
    truncated = False
    for index, row in enumerate(sheet.iter_rows(values_only=True)):
        if index >= MAX_ROWS:
            truncated = True
            break
        rows.append([cell_text(value) for value in row])
    return {'source': 'openpyxl', 'sheet': sheet.title, 'sheets': sheets,
            'colWidths': widths, 'rows': trim(rows), 'truncated': truncated}


def via_ooxml(path):
    import re
    import xml.etree.ElementTree as ET
    import zipfile

    MAIN = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
    REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
    PKG_REL = '{http://schemas.openxmlformats.org/package/2006/relationships}'

    def text_of(node):
        pieces = []
        for t in node.iter(MAIN + 't'):
            pieces.append(t.text or '')
        return ''.join(pieces)

    with zipfile.ZipFile(path) as zip_file:
        shared = []
        if 'xl/sharedStrings.xml' in zip_file.namelist():
            root = ET.fromstring(zip_file.read('xl/sharedStrings.xml'))
            for item in root.findall(MAIN + 'si'):
                shared.append(text_of(item))
        book = ET.fromstring(zip_file.read('xl/workbook.xml'))
        sheets = []
        for sheet in book.iter(MAIN + 'sheet'):
            sheets.append({'name': sheet.get('name') or '', 'rid': sheet.get(REL + 'id') or ''})
        targets = {}
        if 'xl/_rels/workbook.xml.rels' in zip_file.namelist():
            rels = ET.fromstring(zip_file.read('xl/_rels/workbook.xml.rels'))
            for rel in rels.findall(PKG_REL + 'Relationship'):
                targets[rel.get('Id') or ''] = rel.get('Target') or ''
        first = sheets[0] if sheets else None
        if first is None:
            raise ValueError('workbook has no sheet')
        target = targets.get(first['rid'], 'worksheets/sheet1.xml')
        if target.startswith('/'):
            target = target[1:]
        elif not target.startswith('xl/'):
            target = 'xl/' + target.lstrip('./')
        sheet_xml = ET.fromstring(zip_file.read(target))
        widths = []
        cols = sheet_xml.find(MAIN + 'cols')
        if cols is not None:
            for col in cols.findall(MAIN + 'col'):
                try:
                    widths.append((int(col.get('min') or 1), int(col.get('max') or 1),
                                   round(float(col.get('width') or 0), 2)))
                except (TypeError, ValueError):
                    continue
        col_widths = []
        for index in range(1, 27):
            found = 0.0
            for item in widths:
                if item[0] <= index <= item[1]:
                    found = item[2]
            col_widths.append(found)
        rows = []
        truncated = False
        sheet_data = sheet_xml.find(MAIN + 'sheetData')
        for row in (sheet_data.findall(MAIN + 'row') if sheet_data is not None else []):
            if len(rows) >= MAX_ROWS:
                truncated = True
                break
            cells = {}
            for cell in row.findall(MAIN + 'c'):
                ref = cell.get('r') or ''
                letters = re.match(r'[A-Z]+', ref)
                column = 0
                for ch in (letters.group(0) if letters else 'A'):
                    column = column * 26 + (ord(ch) - 64)
                kind = cell.get('t') or 'n'
                if kind == 's':
                    value = cell.find(MAIN + 'v')
                    try:
                        text = shared[int(value.text)] if value is not None and value.text else ''
                    except (ValueError, IndexError):
                        text = ''
                elif kind == 'inlineStr':
                    value = cell.find(MAIN + 'is')
                    text = text_of(value) if value is not None else ''
                else:
                    value = cell.find(MAIN + 'v')
                    text = (value.text or '') if value is not None else ''
                cells[column] = text
            if not cells:
                rows.append([])
                continue
            width = max(cells)
            rows.append([cells.get(i, '') for i in range(1, width + 1)])
    return {'source': 'ooxml', 'sheet': first['name'], 'sheets': [s['name'] for s in sheets],
            'colWidths': col_widths, 'rows': trim(rows), 'truncated': truncated}


def main():
    if len(sys.argv) < 2:
        raise SystemExit('usage: xlsx-text.py <in.xlsx>')
    path = sys.argv[1]
    # PRINTER_OOXML_FORCE=1 强制走零依赖的 zip+ElementTree 解析（自测用）
    force = os.environ.get('PRINTER_OOXML_FORCE') == '1'
    try:
        if force:
            raise RuntimeError('PRINTER_OOXML_FORCE=1')
        data = via_openpyxl(path)
    except Exception:
        data = via_ooxml(path)
    if not data['rows']:
        raise SystemExit('xlsx first sheet is empty: ' + path)
    print(json.dumps(data, ensure_ascii=False))


if __name__ == '__main__':
    main()
