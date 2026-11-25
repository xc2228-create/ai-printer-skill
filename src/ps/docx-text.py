# Extract structured text from a .docx (打印链路 B：保内容，零依赖可用).
# Usage: python docx-text.py <in.docx>
# Prints one JSON object:
#   {"source":"python-docx"|"ooxml", "paragraphs":[{"text":"...","level":0|1|2|3}]}
# level 0 = normal body text; 1/2/3 = Word Heading 1/2/3 (or 标题 1/2/3).
import json
import os
import re
import sys
import zipfile

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
HEADING_RE = re.compile(r'^(?:heading|标题)\s*([1-9])$', re.IGNORECASE)


def level_of_style(name):
    if not name:
        return 0
    match = HEADING_RE.match(str(name).strip())
    if not match:
        return 0
    level = int(match.group(1))
    return level if level <= 3 else 0


def via_python_docx(path):
    import docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    document = docx.Document(path)
    paragraphs = []
    for child in document.element.body.iterchildren():
        tag = child.tag
        if tag == W + 'p':
            para = Paragraph(child, document)
            text = para.text.replace('\r', '').strip()
            if text == '':
                continue
            level = level_of_style(para.style.name if para.style is not None else '')
            paragraphs.append({'text': text, 'level': level})
        elif tag == W + 'tbl':
            table = Table(child, document)
            for row in table.rows:
                cells = []
                for cell in row.cells:
                    cells.append(cell.text.replace('\r', ' ').replace('\n', ' ').strip())
                line = ' | '.join(cells).strip()
                if line.strip(' |') != '':
                    paragraphs.append({'text': line, 'level': 0})
    return paragraphs


def style_name_map(zip_file):
    try:
        raw = zip_file.read('word/styles.xml')
    except KeyError:
        return {}
    import xml.etree.ElementTree as ET
    root = ET.fromstring(raw)
    names = {}
    for style in root.iter(W + 'style'):
        style_id = style.get(W + 'styleId')
        name_el = style.find(W + 'name')
        if style_id and name_el is not None:
            names[style_id] = name_el.get(W + 'val') or ''
    return names


def via_ooxml(path):
    import xml.etree.ElementTree as ET
    with zipfile.ZipFile(path) as zip_file:
        names = style_name_map(zip_file)
        raw = zip_file.read('word/document.xml')
    root = ET.fromstring(raw)
    body = root.find(W + 'body')
    if body is None:
        raise ValueError('word/document.xml has no <w:body>')
    paragraphs = []
    for child in body:
        if child.tag == W + 'p':
            pieces = []
            for node in child.iter():
                if node.tag == W + 't':
                    pieces.append(node.text or '')
                elif node.tag == W + 'tab':
                    pieces.append('\t')
                elif node.tag == W + 'br':
                    pieces.append(' ')
            text = ''.join(pieces).strip()
            if text == '':
                continue
            level = 0
            style_el = child.find(W + 'pPr/' + W + 'pStyle')
            if style_el is not None:
                style_id = style_el.get(W + 'val') or ''
                level = level_of_style(names.get(style_id, style_id))
            paragraphs.append({'text': text, 'level': level})
        elif child.tag == W + 'tbl':
            for row in child.iter(W + 'tr'):
                cells = []
                for cell in row.findall(W + 'tc'):
                    pieces = [(node.text or '') for node in cell.iter(W + 't')]
                    cells.append(' '.join(''.join(pieces).split()))
                line = ' | '.join(cells).strip()
                if line.strip(' |') != '':
                    paragraphs.append({'text': line, 'level': 0})
    return paragraphs


def main():
    if len(sys.argv) < 2:
        raise SystemExit('usage: docx-text.py <in.docx>')
    path = sys.argv[1]
    # PRINTER_OOXML_FORCE=1 强制走零依赖的 zip+ElementTree 解析（自测用）
    force = os.environ.get('PRINTER_OOXML_FORCE') == '1'
    source = 'python-docx'
    try:
        if force:
            raise RuntimeError('PRINTER_OOXML_FORCE=1')
        paragraphs = via_python_docx(path)
    except Exception:
        source = 'ooxml'
        paragraphs = via_ooxml(path)
    if not paragraphs:
        raise SystemExit('docx has no extractable text: ' + path)
    print(json.dumps({'source': source, 'paragraphs': paragraphs}, ensure_ascii=False))


if __name__ == '__main__':
    main()
