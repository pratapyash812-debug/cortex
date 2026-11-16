"""One folder import: readable notes with exact originals, no AI or network."""
from __future__ import annotations
import codecs
import csv
import hashlib
import io
import itertools
import json
import re
import tempfile
import threading
import time
import uuid
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

def _spreadsheet(blob, selected=None):
    with course._package(blob) as package:
        wb=course._xml(package,'xl/workbook.xml');rels=course._xml(package,'xl/_rels/workbook.xml.rels')
        if wb is None or rels is None:raise ValueError('Workbook structure is missing')
        shared=course._xml(package,'xl/sharedStrings.xml')
        strings=[''.join(n.text or '' for n in item.iter('{'+course.S+'}t')) for item in shared] if shared is not None else []
        targets={r.get('Id'):r.get('Target','') for r in rels if r.get('TargetMode')!='External'}
        out=['These tables show stored values or literal formulas. Cortex does not calculate spreadsheets. Cached results may be out of date. Charts and formatting remain in the original.']
        sheets=list(wb.iter('{'+course.S+'}sheet'))
        if selected is not None:
            sheets=[sheet for sheet in sheets if sheet.get('name') in selected]
        if not sheets:
            out+=['','No worksheets were selected. Open the original workbook to view the data.']
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

def convert_upload(data:bytes,name:str,dest_folder='Imported notes',*,sources=None,options=None,report=False,progress=None)->dict:
    # Reuse the bounded archive/path parser and exact-source preservation.
    output=course.convert_upload(data,name,dest_folder,sources=sources,report=report,progress=progress)
    if not output:
        return {}
    source_names=output.pop('__source_names__',{})
    outcomes=[]
    grouping={};document_notes=[];extra_notes=0
    names=Names();names.used.update(k.lower() for k in output)
    warnings=output.setdefault('__warnings__',[])
    document_entries=[]
    for path,old in list(output.items()):
        if not path.endswith('.md') or not isinstance(old,str):continue
        meta,_=_split(old);source=meta.get('source');kind=meta.get('source_format')
        if source and source in output:document_entries.append((path,meta,source,kind))
    for index,(path,meta,source,kind) in enumerate(document_entries):
        original=source_names.get(path,PurePosixPath(source).name)
        if progress is not None and not progress('Converting', index,len(document_entries), original):
            # Unprocessed documents retain their original and companion as a
            # durable record. Retry can convert each later without re-uploading.
            for waiting, _meta, saved, ext in document_entries[index:]:
                outcomes.append({'name':source_names.get(waiting,PurePosixPath(saved).name),'original':saved,'note':waiting,
                                 'format':ext,'status':'pending','detail':'Original kept. Conversion was stopped.',
                                 'sha256':hashlib.sha256(output[saved]).hexdigest()})
                document_notes.append(waiting)
            break
        option=(options or {}).get(original,{})
        if option.get('sourceModified'):
            meta['sourceModified']=option['sourceModified']
        if report:
            meta['importedAt']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
        outcome='editable'
        detail=''
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
                stats = output['__stats__']
                converted_stats = converted.pop('__stats__', {})
                for key in ('tables','equations','math_fallbacks'):
                    stats[key] = stats.get(key, 0) + converted_stats.get(key, 0)
                stats['attachments'] += sum(isinstance(value,bytes) for value in converted.values())
                converted.pop('__mtimes__',None);output.update(converted)
            elif kind=='pptx':body=readable_import.slides(blob,path,names,output,warnings)
            elif kind=='xlsx':body=_spreadsheet(blob,option.get('sheets'))
            elif kind=='pdf':
                body=f'![[{source}]]\n\n## My notes\n'
                outcome='original'
            elif kind in ('txt','md','csv','tsv'):
                text=blob.decode(option.get('encoding','utf-8-sig'),errors='strict' if report else 'replace')
                if kind in ('csv','tsv') and report:
                    body=render_delimited(text,option.get('separator','\t' if kind=='tsv' else ','))
                else:
                    body=text if kind=='md' else course.html_md.esc(text)
            elif kind in ('html','htm'):
                from html_md import html_to_markdown
                body=html_to_markdown(blob.decode('utf-8-sig',errors='replace'),image=lambda src,alt: course.html_md.esc(alt) or '[Image retained in original HTML]')
            if body is not None:
                if not option.get('singlePage'):
                    body,children=readable_import.section_notes(path,body,meta,names,output)
                else:
                    children=[]
                if children:
                    grouping[path]=children;extra_notes+=len(children)
                output[path]=with_frontmatter(meta,f'Original: [[{source}]]\n\n'+body+'\n')
            else:
                outcome='original'
                detail='Open the retained original for the complete material.'
        except (ValueError,KeyError,RuntimeError,NotImplementedError,course.ET.ParseError,course.zipfile.BadZipFile,csv.Error) as error:
            outcome='attention'
            detail=str(error)[:240]
            warnings.append(f'{source}: full conversion unavailable ({detail}); the source overview and exact original are retained.')
        if report:
            outcomes.append({'name':original,'original':source,'note':path,'format':kind,'status':outcome,'detail':detail,
                             'sha256':hashlib.sha256(blob).hexdigest()})
    output[f'{dest_folder}/Course index.md']=output[f'{dest_folder}/Course index.md'].replace('Original files are preserved under Sources. Each linked companion gives a bounded overview and a place to collect study notes.','Open a document below to read it and add your notes. Original files are preserved under Sources.').replace('Generated explanations use English. Keep Danish subject terms and quotations in your notes when useful.','Your original language is preserved.')
    old_index=f'{dest_folder}/Course index.md'
    root_index=names.take(dest_folder,safe_name(PurePosixPath(dest_folder).name,'Imported notes',80,title=True),'md')
    output[root_index]=output.pop(old_index)
    grouping[root_index]=document_notes
    output['__notebooks__']=grouping
    output['__stats__']['pages']+=extra_notes
    output['__stats__']['notes']+=extra_notes
    if report:
        output['__source_report__']=outcomes
        output['__root__']=root_index
    return output

def render_delimited(text, separator):
    rows = list(itertools.islice(csv.reader(io.StringIO(text, newline=''), delimiter=separator, strict=True), 201))
    if not rows:
        return ''
    width = max(1, min(20, max(map(len, rows))))
    def line(values):
        cells = [course.html_md.esc(value).replace('|', r'\|').replace('\n', ' ') for value in values[:width]]
        return '| ' + ' | '.join(cells + ['']*(width-len(cells))) + ' |'
    table = [line(rows[0]), line(['---']*width), *(line(row) for row in rows[1:200])]
    if len(rows) > 200 or any(len(row)>20 for row in rows):
        table.extend(['','Table preview: first 200 rows and 20 columns. The complete original is retained.'])
    return '\n'.join(table)


def _text_encoding(data):
    if data.startswith((codecs.BOM_UTF16_LE,codecs.BOM_UTF16_BE)):
        return 'utf-16'
    try:
        codecs.getincrementaldecoder('utf-8-sig')().decode(data[:65536],final=len(data)<=65536)
    except UnicodeDecodeError:
        return 'cp1252'
    return 'utf-8-sig'


def inspect_source(name, blob):
    path = PurePosixPath(name)
    suffix = path.suffix.lower()
    result = {'name':name,'format':suffix.lstrip('.'),'bytes':len(blob),'sha256':hashlib.sha256(blob).hexdigest()}
    try:
        if suffix == '.xlsx':
            with course._package(blob) as package:
                root = course._xml(package,'xl/workbook.xml')
                if root is not None:
                    sheets = [sheet.get('name','Worksheet') for sheet in root.iter('{'+course.S+'}sheet')]
                    result['sheets'] = sheets[:8]
                    result['sheetCount'] = len(sheets)
        elif suffix == '.docx':
            with course._package(blob) as package:
                document = course._xml(package, 'word/document.xml')
                tag = '{'+course.W+'}'
                headings = []
                if document is not None:
                    for paragraph in document.iter(tag+'p'):
                        style=paragraph.find(f'{tag}pPr/{tag}pStyle')
                        if style is None or not style.get(tag+'val','').lower().startswith(('heading','title','overskrift')):
                            continue
                        label=''.join(node.text or '' for node in paragraph.iter(tag+'t')).strip()
                        if label:
                            headings.append(label[:150])
                        if len(headings)==12:
                            break
                result['headings'] = headings
                result['canSplit'] = True
        elif suffix in ('.csv','.tsv','.txt','.md'):
            encoding = _text_encoding(blob)
            result['encoding'] = encoding
            sampled = blob[:6000]
            sample = sampled.decode(encoding,errors='replace')[:1800]
            result['samples'] = {codec: sampled.decode(codec,errors='replace')[:1800]
                                 for codec in ('utf-8-sig','cp1252','utf-16')}
            if suffix in ('.csv','.tsv'):
                separator = '\t' if suffix == '.tsv' else ','
                try: separator = csv.Sniffer().sniff(sample, delimiters=',;\t').delimiter
                except csv.Error: pass
                result['separator'] = separator
            elif suffix=='.md':
                result['headings'] = re.findall(r'^#{1,3}\s+(.+)$', sample, re.M)[:12]
                result['canSplit'] = True
    except (ValueError, KeyError, RuntimeError, NotImplementedError, course.ET.ParseError, course.zipfile.BadZipFile) as error:
        result['warning'] = str(error)[:160]
    return result


def clean_options(raw):
    if not isinstance(raw, dict):
        raise ValueError('Invalid import options')
    result={}
    for name, option in raw.items():
        if not isinstance(name,str) or not isinstance(option,dict):
            raise ValueError('Invalid file options')
        clean={}
        for key in ('singlePage','skip'):
            if key in option:
                if not isinstance(option[key],bool): raise ValueError('Invalid file options')
                clean[key]=option[key]
        if 'encoding' in option:
            if option['encoding'] not in ('utf-8-sig','cp1252','utf-16'): raise ValueError('Choose a supported text encoding')
            clean['encoding']=option['encoding']
        if 'separator' in option:
            if option['separator'] not in (',',';','\t'): raise ValueError('Choose a supported column separator')
            clean['separator']=option['separator']
        if 'sheets' in option:
            if not isinstance(option['sheets'],list) or len(option['sheets'])>8 or not all(isinstance(s,str) for s in option['sheets']):
                raise ValueError('Select up to eight worksheets')
            clean['sheets']=option['sheets']
        result[name]=clean
    return result


class StudyImports:
    """Bounded in-memory previews and durable library reports."""
    LIMIT = 384 * 1024**2

    def __init__(self,vault):
        self.vault=vault
        self.lock=threading.RLock()
        self.sessions={}
        self.directory=vault.root/'.cortex'/'import-reports'

    def reports(self):
        result=[]
        for path in sorted(self.directory.glob('*.json'), key=lambda p:p.stat().st_mtime, reverse=True)[:100]:
            try:
                record=json.loads(path.read_text(encoding='utf-8'))
                if record.get('id')==path.stem:
                    result.append(record)
            except (ValueError,OSError,AttributeError):
                continue
        return result

    def preview(self,data,name,subject='',modified=''):
        warnings=[]
        timestamps={}
        if re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z',modified):
            timestamps[PurePosixPath(name).name]=modified
        if PurePosixPath(name).suffix.lower()=='.zip':
            try:
                with course.zipfile.ZipFile(io.BytesIO(data)) as archive:
                    if (len(archive.infolist())>course.MAX_ZIP_FILES or
                        sum(item.file_size for item in archive.infolist())>self.LIMIT):
                        raise ValueError('The expanded archive is too large to preview')
                    for item in archive.infolist():
                        if not item.is_dir():
                            year,month,day,hour,minute,second=item.date_time
                            timestamps[item.filename.replace('\\','/')]=f'{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}'
            except course.zipfile.BadZipFile as error:
                raise ValueError('This ZIP could not be opened') from error
        sources=course._inputs(data,name,warnings)
        if len(sources)>course.MAX_SOURCES or sum(map(lambda pair:len(pair[1]),sources))>self.LIMIT:
            raise ValueError('This batch is too large to preview. Choose up to 300 files totalling less than 384 MB.')
        rows=[]
        accepted=[]
        existing={}
        for report in self.reports():
            for item in report.get('items',()):
                source=item.get('original')
                if source and self.vault._is_file(source):
                    existing.setdefault((item.get('sha256'),PurePosixPath(item.get('name','')).name),item.get('note') or source)
        for source,blob in sources:
            p=PurePosixPath(source)
            if p.is_absolute() or '..' in p.parts or len(source)>course.MAX_RELATIVE_PATH or p.suffix.lower() not in course.ALLOWED:
                rows.append({'name':source,'format':p.suffix.lstrip('.'),'bytes':len(blob),'unsupported':True})
                continue
            if p.name.startswith(('._','~$','.DS_Store')) or '__MACOSX' in p.parts:
                continue
            row=inspect_source(source,blob)
            if source in timestamps:
                row['sourceModified']=timestamps[source]
            duplicate=existing.get((row['sha256'],p.name))
            if duplicate:
                row['duplicate']=duplicate
            rows.append(row)
            accepted.append((source,blob))
        if not accepted:
            raise ValueError('Choose at least one supported document')
        session_id=uuid.uuid4().hex
        state={'id':session_id,'name':name,'files':rows,'sources':accepted,'phase':'Ready to import','processed':0,'total':len(accepted),'cancelled':False,'created':time.monotonic()}
        with self.lock:
            self.sessions={key:value for key,value in self.sessions.items() if value.get('active') or time.monotonic()-value['created']<3600}
            reusable=[key for key,value in self.sessions.items() if not value.get('active')]
            if reusable:
                self.sessions.pop(reusable[0])
            self.sessions[session_id]=state
        return {'id':session_id,'files':rows,'folder':subject or folder_title(name),'warnings':warnings}

    def status(self,ident):
        with self.lock:
            result=self.sessions.get(ident)
            if result is None: raise ValueError('This import preview expired. Choose your files again.')
            return {key:result[key] for key in ('phase','processed','total','cancelled')}

    def cancel(self,ident):
        with self.lock:
            self.status(ident)
            self.sessions[ident]['cancelled']=True
        return {'accepted':True}

    def _write(self, state, subject, options, existing):
        v=self.vault
        if not isinstance(subject,str) or not subject.strip():
            raise ValueError('Choose a subject for this import')
        title=course.safe_part(subject,'Imported notes')
        selected=[(name,blob) for name,blob in state['sources'] if not options.get(name,{}).get('skip')]
        skipped=[{'name':row['name'],'format':row['format'],'status':'skipped',
                  'detail':'Unsupported file type.' if row.get('unsupported') else 'Skipped during review.'}
                 for row in state['files'] if row.get('unsupported') or options.get(row['name'],{}).get('skip')]
        if not selected:
            return {'written':0,'folder':'','stats':{'skipped':len(skipped)},'items':skipped,'warnings':[]}

        subject_folder=v.resolve(subject) if existing else None
        notebooks=v._read_notebooks()
        nested={member for members in notebooks.values() for member in members}
        notebook=next((path for path in notebooks if path not in nested and PurePosixPath(path).stem==subject and v._is_file(path)),None)
        if existing and not (notebook or subject_folder.is_dir()):
            raise ValueError('The chosen subject is no longer available')
        folder = f'{subject}/{folder_title(state["name"])}' if existing else title
        base=folder; number=1
        while v.resolve(folder).exists() or (not existing and v.resolve(folder+'.md').is_file()):
            number+=1
            folder=f'{base} {number}'
        def progress(phase,completed,total,current):
            with self.lock:
                state.update(phase=phase,processed=completed,total=total)
                return not state['cancelled']
        converted=convert_upload(b'',state['name'],folder,sources=selected,options=options,report=True,progress=progress)
        if not converted:
            return {'written':0,'folder':'','stats':{},'items':skipped,'warnings':[], 'cancelled':True}
        outcomes=converted.pop('__source_report__')
        index=converted.pop('__root__')
        with self.lock: state['phase']='Saving notes and originals'
        result=self._publish(converted,folder,notebook if existing else None,index)
        stats = result['stats']
        stats['skipped'] = len(skipped)
        return {**result,'folder':folder,'items':outcomes+skipped,'cancelled':state['cancelled']}

    def _publish(self, converted, folder, notebook, index):
        v=self.vault
        groups=converted.pop('__notebooks__')
        stats=converted.pop('__stats__')
        warnings=converted.pop('__warnings__',[])
        converted.pop('__mtimes__',None)
        parent=v.root/'.cortex'
        with tempfile.TemporaryDirectory(prefix='.import-', dir=parent) as temporary:
            stage=type(v.root)(temporary)/'files'
            stage.mkdir()
            for path,value in converted.items():
                relative=PurePosixPath(path).relative_to(folder)
                output=stage.joinpath(*relative.parts)
                if not output.resolve().is_relative_to(stage):
                    raise ValueError('An imported filename was outside the new folder')
                output.parent.mkdir(parents=True,exist_ok=True)
                output.write_bytes(value if isinstance(value,bytes) else value.encode('utf-8'))
            with v._note_save_lock,v._nb_lock:
                destination=v.resolve(folder)
                notebooks=v._validate_import_groups(converted,groups)
                if notebook:
                    if notebook not in notebooks or not v._is_file(notebook):
                        raise ValueError('The chosen subject changed during import')
                    notebooks[notebook]=[*notebooks[notebook],index]
                if destination.exists():
                    raise ValueError('This folder already exists. Choose a new subject name.')
                destination.parent.mkdir(parents=True,exist_ok=True)
                stage.rename(destination)
                try:
                    v._write_notebooks(notebooks)
                except OSError:
                    destination.rename(stage)
                    raise
        return {'written':len(converted),'stats':stats,'warnings':warnings}

    def commit(self,ident,subject,raw_options,existing):
        options=clean_options(raw_options)
        with self.lock:
            self.status(ident)
            state=self.sessions[ident]
            if 'result' in state: return state['result']
            if state.get('active'): raise ValueError('This import is already running')
            state['active']=True
        try:
            for row in state['files']:
                option=options.setdefault(row['name'],{})
                for key in ('encoding','separator','sourceModified'):
                    if key in row: option.setdefault(key,row[key])
            result=self._write(state,subject,options,existing)
            result.update(id=ident,time=time.time())
            with self.lock:
                state.update(result=result,phase='Ready to review',sources=[])
            if result['items']:
                self.directory.mkdir(parents=True,exist_ok=True)
                try:
                    self.vault._write_json_atomic(self.directory/(ident+'.json'), result)
                except OSError:
                    result.setdefault('warnings',[]).append('Files were imported, but the report could not be kept.')
            return result
        finally:
            with self.lock: state['active']=False

    def retry(self,ident):
        report=next((record for record in self.reports() if record['id']==ident),None)
        if not report: raise ValueError('This import report is no longer available')
        sources=[]
        for item in report['items']:
            if item['status'] not in ('attention','pending'): continue
            source=self.vault.resolve(item['original'])
            if not source.is_file(): continue
            blob=source.read_bytes()
            if hashlib.sha256(blob).hexdigest()==item['sha256']:
                sources.append((item['name'],blob))
        if not sources: raise ValueError('There are no available originals to retry')
        session_id=uuid.uuid4().hex
        with self.lock:
            self.sessions[session_id]={'id':session_id,'name':'Retried materials','files':[inspect_source(name,blob) for name,blob in sources],
                                      'sources':sources,'phase':'Ready to retry','processed':0,'total':len(sources),'cancelled':False,'created':time.monotonic()}
        return {'id':session_id,'files':self.sessions[session_id]['files'],'folder':'Retried materials','warnings':[]}
