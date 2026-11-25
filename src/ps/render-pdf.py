# Render every page of a PDF to a 200 dpi PNG with PyMuPDF.
# Usage: python render-pdf.py <in.pdf> <out-dir> [dpi] [--count]
#   --count  inspect only: print page count and page geometry, render nothing.
# Prints one JSON object:
#   render: {pages, images:[{page,path,width,height}]}
#   count : {pages, countOnly:true, width, height, landscape, landscapePages}
import json
import os
import sys
import warnings

warnings.filterwarnings('ignore')

try:
    import pymupdf
except ImportError:
    import fitz as pymupdf


def open_checked(pdf):
    doc = pymupdf.open(pdf)
    if getattr(doc, 'needs_pass', False):
        raise SystemExit('PDF is password protected: ' + pdf)
    if doc.page_count <= 0:
        raise SystemExit('PDF has no pages: ' + pdf)
    return doc


def count_only(pdf):
    doc = open_checked(pdf)
    first = doc[0].rect
    landscape_pages = 0
    for page in doc:
        if page.rect.width > page.rect.height:
            landscape_pages += 1
    print(json.dumps({
        'pages': doc.page_count,
        'countOnly': True,
        'width': round(first.width, 2),
        'height': round(first.height, 2),
        'landscape': first.width > first.height,
        'landscapePages': landscape_pages,
    }))
    doc.close()


def render(pdf, out_dir, dpi):
    doc = open_checked(pdf)
    os.makedirs(out_dir, exist_ok=True)
    images = []
    for index, page in enumerate(doc):
        pix = page.get_pixmap(dpi=dpi)
        name = 'page-%02d.png' % (index + 1)
        target = os.path.join(out_dir, name)
        pix.save(target)
        images.append({
            'page': index + 1,
            'path': target,
            'width': pix.width,
            'height': pix.height,
        })
    print(json.dumps({'pages': doc.page_count, 'images': images}))
    doc.close()


def main():
    argv = sys.argv[1:]
    inspect = '--count' in argv
    rest = [a for a in argv if a != '--count']
    if len(rest) < 1:
        raise SystemExit('usage: render-pdf.py <in.pdf> [out-dir] [dpi] [--count]')
    pdf = rest[0]
    if inspect:
        count_only(pdf)
        return
    out_dir = rest[1] if len(rest) > 1 else '.'
    dpi = int(rest[2]) if len(rest) > 2 else 200
    render(pdf, out_dir, dpi)


if __name__ == '__main__':
    main()
