"""A bounded course library: exact originals and small, linked study companions.

This previews structure, never edits/recalculates Office files or executes HTML.
The caller reserves a fresh destination namespace before writing the result.
"""
from __future__ import annotations

import io
import re
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import PurePosixPath

import html_md
from docx_import import _checked_zip, _destination
from import_common import MAX_ZIP_BYTES, MAX_ZIP_FILES, Names, safe_name, with_frontmatter

ALLOWED = {'.docx', '.xlsx', '.pptx', '.pdf', '.doc', '.xls', '.ppt', '.html', '.htm', '.txt', '.md', '.csv', '.tsv'}
MAX_SOURCES = 300
MAX_NOTE_CHARS = 12_000
MAX_INDEX_CHARS = 180_000
MAX_XML_BYTES = 24 * 1024 ** 2
MAX_PREVIEW_ITEMS = 32
MAX_RELATIVE_PATH = 220
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
M = 'http://schemas.openxmlformats.org/officeDocument/2006/math'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
RESERVED = re.compile(r'^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', re.I)


def plain(text: str, limit: int = 180) -> str:
    """One bounded, escaped source excerpt, safe as a Markdown list item."""
    text = re.sub(r'\s+', ' ', text or '').strip()
    if len(text) > limit:
        text = text[:limit - 1] + '…'
    return html_md.esc(text).replace('|', r'\|')


def safe_part(text: str, fallback: str = 'Document') -> str:
    cleaned = safe_name(text, fallback, 70, title=True)
    return '_' + cleaned if RESERVED.match(cleaned) else cleaned


def _xml(package: zipfile.ZipFile, name: str) -> ET.Element | None:
    try:
        info = package.getinfo(name)
    except KeyError:
        return None
    if info.file_size > MAX_XML_BYTES:
        raise ValueError(f'{name} exceeds the bounded XML preview limit')
    blob = package.read(info)
    if b'<!ENTITY' in blob.upper() or b'<!DOCTYPE' in blob.upper():
        raise ValueError(f'{name} declares entities or a document type')
    root = ET.fromstring(blob)
    aliases = {'http://purl.oclc.org/ooxml/wordprocessingml/main': W,
               'http://purl.oclc.org/ooxml/officeDocument/math': M,
               'http://purl.oclc.org/ooxml/drawingml/main': A,
               'http://purl.oclc.org/ooxml/spreadsheetml/main': S,
               'http://purl.oclc.org/ooxml/officeDocument/relationships': R}
    for node in root.iter():
        for old, new in aliases.items():
            if node.tag.startswith('{' + old + '}'):
                node.tag = '{' + new + '}' + node.tag.split('}', 1)[1]
            for key in list(node.attrib):
                if key.startswith('{' + old + '}'):
                    node.set('{' + new + '}' + key.split('}', 1)[1], node.attrib.pop(key))
    return root


def _package(blob: bytes) -> zipfile.ZipFile:
    package = zipfile.ZipFile(io.BytesIO(blob))
    infos = package.infolist()
    if len(infos) > MAX_ZIP_FILES or sum(item.file_size for item in infos) > MAX_ZIP_BYTES:
        package.close()
        raise ValueError('Office package exceeds the safe ZIP limit')
    if any(item.flag_bits & 1 for item in infos):
        package.close()
        raise ValueError('Encrypted Office package cannot be previewed')
    return package


def _word(package: zipfile.ZipFile) -> list[str]:
    root = _xml(package, 'word/document.xml')
    if root is None:
        raise ValueError('Word document body is missing')
    paragraphs, headings, samples = 0, [], []
    for node in root.iter('{' + W + '}p'):
        text = ''.join(item.text or '' for item in node.iter('{' + W + '}t')).strip()
        if not text:
            continue
        paragraphs += 1
        style = node.find('{' + W + '}pPr/{' + W + '}pStyle')
        style_name = style.get('{' + W + '}val', '') if style is not None else ''
        if style_name.lower().startswith(('heading', 'title', 'overskrift')) and len(headings) < MAX_PREVIEW_ITEMS:
            headings.append(f'- Paragraph {paragraphs}: {plain(text)}')
        if len(samples) < 3:
            samples.append(f'- Paragraph {paragraphs}: {plain(text, 220)}')
    tables = sum(1 for _ in root.iter('{' + W + '}tbl'))
    equations = sum(1 for _ in root.iter('{' + M + '}oMath'))
    lines = ['## Word source', '', f'{paragraphs:,} nonempty paragraphs, {tables:,} tables and {equations:,} native equations.', '',
             'This companion keeps the source manageable. Use Word documents import when you want an editable conversion; create short topic notes for study and AI review.']
    if headings:
        lines += ['', '### Section headings', ''] + headings
        if len(headings) == MAX_PREVIEW_ITEMS:
            lines += ['', 'Heading preview is limited to the first 32 sections. Open the original for the complete document.']
    elif samples:
        lines += ['', '### Opening source excerpts', ''] + samples
    return lines


def _slides(package: zipfile.ZipFile) -> list[str]:
    names = sorted((name for name in package.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml', name)),
                   key=lambda name: int(re.search(r'(\d+)\.xml', name).group(1)))
    if not names:
        raise ValueError('PowerPoint has no readable slide XML')
    lines = ['## Presentation source', '', f'{len(names):,} slides. Slide layout, diagrams and speaker notes remain in the original.', '', '### Slide headings', '']
    for number, name in enumerate(names[:MAX_PREVIEW_ITEMS], 1):
        root = _xml(package, name)
        texts = [item.text or '' for item in root.iter('{' + A + '}t')] if root is not None else []
        label = next((text.strip() for text in texts if text.strip()), '')
        lines.append(f'- Slide {number}: {plain(label) if label else "Visual content; open the original slide."}')
    if len(names) > MAX_PREVIEW_ITEMS:
        lines += ['', f'Preview shows the first {MAX_PREVIEW_ITEMS} of {len(names):,} slides.']
    return lines


def _spreadsheet(package: zipfile.ZipFile) -> list[str]:
    root = _xml(package, 'xl/workbook.xml')
    relations = _xml(package, 'xl/_rels/workbook.xml.rels')
    if root is None or relations is None:
        raise ValueError('Workbook or worksheet relationships are missing')
    target_of = {item.get('Id'): item.get('Target', '') for item in relations if item.get('TargetMode') != 'External'}
    sheets = list(root.iter('{' + S + '}sheet'))
    lines = ['## Spreadsheet source', '', f'{len(sheets):,} worksheets. Original formulas, values, formatting and dependencies are preserved in the workbook bytes.', '',
             'Formula counts describe stored formulas. No calculation or correctness check was performed.', '', '### Worksheets', '']
    for sheet in sheets[:MAX_PREVIEW_ITEMS]:
        title = sheet.get('name', 'Worksheet')
        target = target_of.get(sheet.get('{' + R + '}id'), '')
        if target.startswith('/'):
            path = target.lstrip('/')
        else:
            parts = []
            for part in ('xl/' + target).split('/'):
                if part == '..':
                    if parts:
                        parts.pop()
                elif part not in ('', '.'):
                    parts.append(part)
            path = '/'.join(parts)
        if not target or not path.startswith('xl/'):
            lines.append(f'- Worksheet **{plain(title)}**: preview unavailable; open the original.')
            continue
        worksheet = _xml(package, path)
        if worksheet is None:
            lines.append(f'- Worksheet **{plain(title)}**: source XML is missing.')
            continue
        formulas = sum(1 for _ in worksheet.iter('{' + S + '}f'))
        cells = sum(1 for _ in worksheet.iter('{' + S + '}c'))
        dimension = worksheet.find('{' + S + '}dimension')
        used = dimension.get('ref', '') if dimension is not None else ''
        locator = f' Range {plain(used, 40)}.' if used else ''
        lines.append(f'- Worksheet **{plain(title)}**: {formulas:,} stored formula cells; {cells:,} stored cells.{locator}')
    if len(sheets) > MAX_PREVIEW_ITEMS:
        lines += ['', f'Preview shows the first {MAX_PREVIEW_ITEMS} of {len(sheets):,} worksheets.']
    return lines


def _preview(blob: bytes, suffix: str) -> tuple[list[str], bool]:
    if suffix in ('.docx', '.pptx', '.xlsx'):
        with _package(blob) as package:
            return {'.docx': _word, '.pptx': _slides, '.xlsx': _spreadsheet}[suffix](package), False
    if suffix == '.pdf':
        return ['## PDF source', '', 'Open the original PDF in the reader to review its pages and diagrams. Add page numbers to your own study notes as you read.', '',
                'This import does not extract or infer a page count.'], False
    if suffix in ('.doc', '.xls', '.ppt'):
        return ['## Legacy Office source', '', 'The complete original is preserved. A structural preview is unavailable for this legacy format. Open it in a compatible application, or save a separate DOCX, XLSX or PPTX copy for a preview.'], True
    if suffix in ('.html', '.htm'):
        return ['## HTML source', '', 'The original HTML bytes are stored with a .txt suffix for safe text viewing. Scripts, embedded pages and external links were not executed or followed.'], True
    text = blob[:4096].decode('utf-8', errors='replace')
    lines = [line.strip() for line in text.splitlines() if line.strip()][:5]
    return ['## Text source', '', 'Opening source excerpts:', ''] + ['- ' + plain(line, 220) for line in lines], False


class Folders:
    def __init__(self):
        self.paths: dict[tuple[str, ...], str] = {(): ''}
        self.used: set[str] = set()

    def take(self, parts: tuple[str, ...], warnings: list[str]) -> str:
        parent = ''
        for depth, original in enumerate(parts, 1):
            key = parts[:depth]
            if key in self.paths:
                parent = self.paths[key]
                continue
            stem = safe_part(original, 'Folder')
            candidate = '/'.join(part for part in (parent, stem) if part)
            number = 2
            while candidate.lower() in self.used:
                candidate = '/'.join(part for part in (parent, f'{stem} {number}') if part)
                number += 1
            self.paths[key] = candidate
            self.used.add(candidate.lower())
            if PurePosixPath(candidate).name != original:
                warnings.append(f'Folder {"/".join(key)} imported as {candidate} to keep a safe, distinct name.')
            parent = candidate
        return parent


def _inputs(data: bytes, name: str, warnings: list[str]) -> list[tuple[str, bytes]]:
    if PurePosixPath(name).suffix.lower() != '.zip':
        return [(PurePosixPath(name.replace('\\', '/')).name, data)]
    try:
        files = _checked_zip(data)
    except (RuntimeError, IndexError, zipfile.BadZipFile) as error:
        raise ValueError('This ZIP folder cannot be read safely: ' + str(error)[:160]) from error
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        info_of = {item.filename.replace('\\', '/'): item for item in archive.infolist()}
    result = []
    for path, blob in files.items():
        # Some macOS-created ZIPs contain UTF-8 name bytes without the UTF-8
        # header flag. Repair only if both encodings round-trip losslessly.
        original = path
        info = info_of.get(path)
        if info is not None and not info.flag_bits & 0x800:
            try:
                repaired = path.encode('cp437').decode('utf-8')
                if repaired.encode('utf-8').decode('cp437') == path and repaired != path:
                    path = repaired
                    warnings.append(f'ZIP filename encoding repaired: {original} → {path}.')
            except (UnicodeEncodeError, UnicodeDecodeError):
                pass
        result.append((path, blob))
    return result


def convert_upload(data: bytes, name: str, dest_folder: str = 'Course import') -> dict:
    """Return exact sources, bounded companions and index; no filesystem writes."""
    destination = _destination(dest_folder)
    warnings: list[str] = []
    inputs = _inputs(data, name, warnings)
    accepted = []
    skipped = unsupported = 0
    for source, blob in inputs:
        path = PurePosixPath(source)
        if path.name.startswith(('._', '~$', '.DS_Store')) or '__MACOSX' in path.parts:
            skipped += 1
            continue
        if path.is_absolute() or '..' in path.parts or re.match(r'^[A-Za-z]:/', source) or len(source) > MAX_RELATIVE_PATH:
            skipped += 1
            warnings.append(f'Skipped an unsafe or overlong source path: {source[:240]}.')
            continue
        if path.suffix.lower() not in ALLOWED:
            skipped += 1
            unsupported += 1
            warnings.append(f'Unsupported course format skipped: {source[:240]}.')
            continue
        accepted.append((source, blob))
    if not accepted:
        raise ValueError('No supported course materials found. Choose Office documents, PDFs, HTML or text files.')
    if len(accepted) > MAX_SOURCES:
        raise ValueError(f'A course import supports at most {MAX_SOURCES} source files; divide this folder into smaller course batches.')
    folders = Folders()
    for source, _ in accepted:
        folders.take(PurePosixPath(source).parts[:-1], warnings)
    names = Names()
    for folder in folders.used:
        names.used.update((f'{destination}/Sources/{folder}'.lower(), f'{destination}/Notes/{folder}'.lower()))
    output = {}
    index = ['# Course materials', '', 'Original files are preserved under Sources. Each linked companion gives a bounded overview and a place to collect study notes.', '',
             'Generated explanations use English. Keep Danish subject terms and quotations in your notes when useful.', '', '## Materials', '']
    failed = preview_unsupported = 0
    formats = Counter()
    for source, blob in accepted:
        path = PurePosixPath(source)
        folder = folders.take(path.parts[:-1], warnings)
        source_folder = '/'.join(part for part in (destination, 'Sources', folder) if part)
        note_folder = '/'.join(part for part in (destination, 'Notes', folder) if part)
        suffix = path.suffix.lower()
        source_stem = safe_part(path.stem)
        source_ext = suffix[1:]
        if suffix in ('.html', '.htm'):
            source_stem = safe_part(path.name)
            source_ext = 'txt'
        saved_source = names.take(source_folder, source_stem, source_ext)
        note_path = names.take(note_folder, safe_part(path.name), 'md')
        output[saved_source] = blob
        formats[suffix[1:]] += 1
        try:
            overview, no_preview = _preview(blob, suffix)
            if no_preview:
                preview_unsupported += 1
                warnings.append(f'{source}: original preserved; this format has no structural preview.')
        except (ValueError, KeyError, RuntimeError, ET.ParseError, zipfile.BadZipFile, NotImplementedError) as error:
            failed += 1
            overview = ['## Source preview unavailable', '', 'The complete original file is preserved. Its structure could not be read by this bounded preview.']
            warnings.append(f'{source}: preview unavailable ({str(error)[:220]}). Original bytes preserved.')
        body = ['# ' + plain(path.name), '', f'Original source: [[{saved_source}]]', '', f'Format: {suffix[1:].upper()}. Size: {len(blob):,} bytes.', ''] + overview
        body += ['', '## My study notes', '', 'Add a short explanation in English, the relevant page, slide or worksheet, and questions to practise. Preserve original Danish terms and quotations where needed.']
        note = with_frontmatter({'type': 'course-source', 'source': saved_source, 'source_format': suffix[1:]}, '\n'.join(body))
        if len(note) > MAX_NOTE_CHARS:
            # Very long source labels or headings cannot turn this feature into
            # another unbounded textbook editor import.
            note = note[:MAX_NOTE_CHARS - 130].rsplit('\n', 1)[0] + '\n\nPreview shortened to keep this companion manageable. Open the original for the complete source.\n'
        output[note_path] = note
        index.append(f'- [[{note_path}|{safe_part(path.name)}]]')
    index_body = '\n'.join(index) + '\n'
    if len(index_body) > MAX_INDEX_CHARS:
        raise ValueError('The course index would be too large; import smaller course batches.')
    output[f'{destination}/Course index.md'] = index_body
    output['__stats__'] = {'pages': len(accepted) + 1, 'notes': len(accepted) + 1, 'attachments': len(accepted), 'sources': len(accepted),
                           'documents': len(accepted), 'converted': len(accepted), 'skipped': skipped,
                           'unsupported': unsupported, 'failed': failed, 'preview_unsupported': preview_unsupported,
                           # One numeric count per format (format_docx, format_pdf, …). The client contract is
                           # Record<string, number> and sums stat values; a nested dict here would break that.
                           **{f'format_{ext}': count for ext, count in formats.items()}}
    if warnings:
        output['__warnings__'] = warnings
    return output
