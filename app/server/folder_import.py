"""One folder import: readable notes with exact originals, no AI or network."""
from __future__ import annotations
import re
from pathlib import PurePosixPath
import yaml
import course_import as course
import docx_import
import readable_import
from import_common import Names,with_frontmatter,safe_name

def folder_title(name):
    stem=PurePosixPath(name).stem
    return safe_name(stem if stem not in ('folder-import','course-import') else 'Imported notes','Imported notes',70,title=True)

def _split(note):
    if note.startswith('---\n'):
        head,body=note[4:].split('\n---\n',1)
        return yaml.safe_load(head) or {},body
    return {},note

def _spreadsheet(blob):
    with course._package(blob) as package:
        wb=course._xml(package,'xl/workbook.xml');rels=course._xml(package,'xl/_rels/workbook.xml.rels')
        if wb is None or rels is None:raise ValueError('Workbook structure is missing')
        shared=course._xml(package,'xl/sharedStrings.xml')
        strings=[''.join(n.text or '' for n in item.iter('{'+course.S+'}t')) for item in shared] if shared is not None else []
        targets={r.get('Id'):r.get('Target','') for r in rels if r.get('TargetMode')!='External'}
        out=['These tables show stored values or literal formulas. Cortex does not calculate spreadsheets. Cached results may be out of date. Charts and formatting remain in the original.']
        sheets=list(wb.iter('{'+course.S+'}sheet'))
        for sheet in sheets[:8]:
            target=targets.get(sheet.get('{'+course.R+'}id'),'')
            if not target:continue
            import posixpath
            target=target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/'+target)
            if not target.startswith('xl/'):continue
            root=course._xml(package,target)
            if root is None:continue
            rows=[]
            for row in list(root.iter('{'+course.S+'}row'))[:101]:
                cells=['']*20
                for cell in row:
                    match=re.match(r'^([A-Z]+)',cell.get('r',''))
                    if not match:continue
                    column=0
                    for letter in match[1]:column=column*26+ord(letter)-64
                    if not 1<=column<=20:continue
                    value=cell.find('{'+course.S+'}v');formula=cell.find('{'+course.S+'}f')
                    text=value.text or '' if value is not None else ''
                    if cell.get('t')=='s':text=strings[int(text)] if text.isdigit() and int(text)<len(strings) else ''
                    elif cell.get('t')=='inlineStr':text=''.join(n.text or '' for n in cell.iter('{'+course.S+'}t'))
                    if formula is not None and not text:text='Formula (not calculated): ='+(formula.text or '')
                    cells[column-1]=course.html_md.esc(text).replace('|',r'\|').replace('\n',' ')
                rows.append(cells)
            width=max((max((i+1 for i,c in enumerate(row) if c),default=1) for row in rows),default=1)
            out+=['', '## '+course.plain(sheet.get('name','Worksheet')),'']
            out+=['| '+' | '.join(chr(65+i) for i in range(width))+' |','| '+' | '.join('---' for _ in range(width))+' |']
            out+=['| '+' | '.join(row[:width])+' |' for row in rows[:100]]
            out+=['','Table preview: up to 100 rows and columns A–T. Open the original for the complete worksheet.']
        if len(sheets)>8:out+=['','Only the first 8 worksheets are shown. Open the original for the rest.']
        return '\n'.join(out)

def convert_upload(data:bytes,name:str,dest_folder='Imported notes')->dict:
    # Reuse the bounded archive/path parser and exact-source preservation.
    output=course.convert_upload(data,name,dest_folder)
    grouping={};document_notes=[];extra_notes=0
    names=Names();names.used.update(k.lower() for k in output)
    warnings=output.setdefault('__warnings__',[])
    for path,old in list(output.items()):
        if not path.endswith('.md') or not isinstance(old,str):continue
        meta,_=_split(old);source=meta.get('source');kind=meta.get('source_format')
        if not source or source not in output:continue
        document_notes.append(path)
        blob=output[source];body=None
        try:
            if kind=='docx':
                converted=docx_import._convert(blob,PurePosixPath(source).name,str(PurePosixPath(path).parent),names=names,path_links=True,note_path=path)
                props,body=_split(converted.pop(path));meta={**props,**meta}
                # The folder already owns one exact original. Equation fallback
                # links reuse it instead of duplicating a large DOCX in assets.
                for extra,value in list(converted.items()):
                    if extra.endswith('.docx') and isinstance(value,bytes) and value==blob:
                        body=body.replace(extra,source);converted.pop(extra)
                warnings.extend(converted.pop('__warnings__',[]))
                converted.pop('__stats__',None);converted.pop('__mtimes__',None);output.update(converted)
            elif kind=='pptx':body=readable_import.slides(blob,path,names,output,warnings)
            elif kind=='xlsx':body=_spreadsheet(blob)
            elif kind=='pdf':body=f'![[{source}]]\n\n## My notes\n'
            elif kind in ('txt','md','csv','tsv'):
                text=blob.decode('utf-8-sig',errors='replace')
                body=text if kind=='md' else course.html_md.esc(text)
            elif kind in ('html','htm'):
                from html_md import html_to_markdown
                body=html_to_markdown(blob.decode('utf-8-sig',errors='replace'),image=lambda src,alt: course.html_md.esc(alt) or '[Image retained in original HTML]')
            if body is not None:
                body,children=readable_import.section_notes(path,body,meta,names,output)
                if children:
                    grouping[path]=children;extra_notes+=len(children)
                output[path]=with_frontmatter(meta,f'Original: [[{source}]]\n\n'+body+'\n')
        except (ValueError,KeyError,RuntimeError,NotImplementedError,course.ET.ParseError,course.zipfile.BadZipFile) as error:
            warnings.append(f'{source}: full conversion unavailable ({error}); the source overview and exact original are retained.')
    output[f'{dest_folder}/Course index.md']=output[f'{dest_folder}/Course index.md'].replace('Original files are preserved under Sources. Each linked companion gives a bounded overview and a place to collect study notes.','Open a document below to read it and add your notes. Original files are preserved under Sources.').replace('Generated explanations use English. Keep Danish subject terms and quotations in your notes when useful.','Your original language is preserved.')
    old_index=f'{dest_folder}/Course index.md'
    root_index=names.take(dest_folder,safe_name(PurePosixPath(dest_folder).name,'Imported notes',80,title=True),'md')
    output[root_index]=output.pop(old_index)
    grouping[root_index]=document_notes
    output['__notebooks__']=grouping
    output['__stats__']['pages']+=extra_notes
    output['__stats__']['notes']+=extra_notes
    return output
