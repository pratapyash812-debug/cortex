"""Readable sections and slide pictures, with the original Office file retained."""
from __future__ import annotations
import posixpath,re
from collections import Counter
from pathlib import PurePosixPath
import course_import as course
from import_common import safe_name,with_frontmatter

SECTION_CHARS=24_000

def markdown_blocks(text):
    """Keep fenced code, maths and tables intact across section boundaries."""
    blocks=[];lines=[];fence=None;math=False
    for line in text.splitlines(keepends=True):
        marker=re.match(r'^\s*(`{3,}|~{3,})',line)
        if marker:
            token=marker[1]
            if fence is None:fence=token
            elif token[0]==fence[0] and len(token)>=len(fence):fence=None
        if fence is None and line.strip()=='$$':math=not math
        if not line.strip() and fence is None and not math:
            if lines:blocks.append(''.join(lines).strip('\n'));lines=[]
        else:lines.append(line)
    if lines:blocks.append(''.join(lines).strip('\n'))
    return blocks

def sections(body,limit=SECTION_CHARS):
    if len(body)<=limit:return [body]
    output=[];current=[];size=0
    for block in markdown_blocks(body):
        heading=bool(re.match(r'^#{1,2} ',block))
        if current and (size+len(block)+2>limit or heading and size>limit//3):
            output.append('\n\n'.join(current));current=[];size=0
        current.append(block);size+=len(block)+2
    if current:output.append('\n\n'.join(current))
    return output

def section_notes(path,body,meta,names,output):
    parts=sections(body)
    if len(parts)==1:return body,[]
    def labels(text):
        found=[]
        for heading in re.findall(r'^#{1,3}\s+(.+)$',text,re.M):
            heading=re.sub(r'\[([^\]]+)\]\([^)]*\)',r'\1',heading)
            heading=re.sub(r'[*_`\[\]]','',heading).strip()
            if heading:found.append(heading)
        return found
    repeated=Counter(label.casefold() for label in labels(body))
    folder=path[:-3];children=[]
    for index,part in enumerate(parts,1):
        headings=labels(part)
        label=next((value for value in headings if repeated[value.casefold()]==1),next((value for value in headings if repeated[value.casefold()]<3),f'Section {index}'))
        stem=f'{index:02d} - '+safe_name(label,'Section',60,title=True)
        child=names.take(folder,stem,'md');children.append(child)
        output[child]=with_frontmatter(meta,f'[[{path}|← Contents]]\n\n'+part+'\n')
    index_body=f'This document is organised into {len(children)} editable sections. All converted text is retained; the original file is preserved.\n\n'
    index_body+='\n'.join(f'- [[{child}|{PurePosixPath(child).stem}]]' for child in children)+'\n'
    return index_body,children

def slides(blob,note_path,names,output,warnings):
    with course._package(blob) as package:
        slide_paths=sorted((n for n in package.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml',n)),key=lambda n:int(re.search(r'(\d+)\.xml',n)[1]))
        out=['Slide text, tables and supported embedded pictures are included below. Slide positioning, native charts, SmartArt and animations remain in the original.']
        pictures={}
        for number,path in enumerate(slide_paths,1):
            root=course._xml(package,path)
            if root is None:continue
            out+=['',f'## Slide {number}','']
            tables=list(root.iter('{'+course.A+'}tbl'))
            table_nodes={id(node) for table in tables for node in table.iter()}
            paragraphs=[p for p in root.iter('{'+course.A+'}p') if id(p) not in table_nodes]
            if paragraphs:
                for paragraph in paragraphs:
                    text=''.join(t.text or '' for t in paragraph.iter('{'+course.A+'}t')).strip()
                    if text:out.append(course.html_md.esc(text))
            else:
                out.extend(course.html_md.esc(t.text.strip()) for t in root.iter('{'+course.A+'}t') if t.text and t.text.strip())
            for table in tables:
                rows=[]
                for row in table.findall('{'+course.A+'}tr'):
                    rows.append([' '.join(''.join(t.text or '' for t in p.iter('{'+course.A+'}t')) for p in cell.iter('{'+course.A+'}p')).strip() for cell in row.findall('{'+course.A+'}tc')])
                width=max((len(r) for r in rows),default=0)
                if width:
                    def render(row):return '| '+' | '.join(course.html_md.esc(value).replace('|',r'\|') for value in row+['']*(width-len(row)))+' |'
                    out+=['',render(rows[0]),'| '+' | '.join('---' for _ in range(width))+' |']+[render(row) for row in rows[1:]]+['']
            relationships=course._xml(package,posixpath.dirname(path)+'/_rels/'+PurePosixPath(path).name+'.rels')
            targets={r.get('Id'):r.get('Target','') for r in relationships if r.get('TargetMode')!='External'} if relationships is not None else {}
            for image in root.iter('{'+course.A+'}blip'):
                target=targets.get(image.get('{'+course.R+'}embed'),'')
                if not target:continue
                source=posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(posixpath.dirname(path),target))
                if not source.startswith('ppt/media/') or source not in package.namelist():continue
                extension=PurePosixPath(source).suffix.lower()
                if extension not in ('.png','.jpg','.jpeg','.gif','.webp','.bmp'):
                    warnings.append(f'Slide {number}: {extension or "embedded image"} picture stays in the original presentation.')
                    continue
                if source not in pictures:
                    saved=names.take(str(PurePosixPath(note_path).parent)+'/attachments',safe_name(PurePosixPath(note_path).stem+' '+PurePosixPath(source).stem,'Slide image',80),extension[1:])
                    output[saved]=package.read(source);pictures[source]=saved
                out+=['',f'![[{pictures[source]}]]','']
            if next(root.iter('{http://schemas.openxmlformats.org/drawingml/2006/chart}chart'),None) is not None or next(root.iter('{http://schemas.openxmlformats.org/drawingml/2006/diagram}relIds'),None) is not None:
                warnings.append(f'Slide {number}: a native chart or SmartArt diagram needs the original presentation for its complete appearance.')
        return '\n\n'.join(out)
