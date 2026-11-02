"""Local, dependency-free editable Word export from Cortex's existing HTML renderer."""
import base64,io,re,struct,zipfile,zlib
from html.parser import HTMLParser
from xml.etree import ElementTree as E
import publish
from docx_math_export import equation
W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
A='http://schemas.openxmlformats.org/drawingml/2006/main';WP='http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';PIC='http://schemas.openxmlformats.org/drawingml/2006/picture'
NS={'w':W,'r':R,'a':A,'wp':WP,'pic':PIC,'m':'http://schemas.openxmlformats.org/officeDocument/2006/math','asvg':'http://schemas.microsoft.com/office/drawing/2016/SVG/main'}
for prefix,uri in NS.items():E.register_namespace(prefix,uri)
def node(tag,*children,**attrs):
    prefix,name=tag.split(':');e=E.Element('{%s}%s'%(NS[prefix],name),{'{%s}%s'%(NS[prefix],k):str(v) for k,v in attrs.items()});e.extend(children);return e
def text_run(text,marks=()):
    t=node('w:t');t.text=re.sub('[\x00-\x08\x0b\x0c\x0e-\x1f]','',text);t.set('{http://www.w3.org/XML/1998/namespace}space','preserve')
    return node('w:r',*([node('w:rPr',*[node('w:'+m,val=v) for m,v in marks])] if marks else []),t)
def xml(n):return E.tostring(n,encoding='utf-8',xml_declaration=True)
def fallback_png():
    def chunk(tag,data):return struct.pack('>I',len(data))+tag+data+struct.pack('>I',zlib.crc32(tag+data))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',1,1,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(b'\0\xff\xff\xff\xff'))+chunk(b'IEND',b'')
class Html:
    def __init__(self,tag='',attrs=None):self.tag=tag;self.attrs=dict(attrs or []);self.children=[]
    @property
    def text(self):return ''.join(c if isinstance(c,str) else c.text for c in self.children)
class Tree(HTMLParser):
    def __init__(self,s):super().__init__(convert_charrefs=True);self.root=Html();self.stack=[self.root];self.feed(s);self.close()
    def handle_starttag(self,tag,attrs):
        n=Html(tag,attrs);self.stack[-1].children.append(n)
        if tag not in ('br','img','hr','input','meta','link'):self.stack.append(n)
    def handle_endtag(self,tag):
        for i in range(len(self.stack)-1,0,-1):
            if self.stack[i].tag==tag:self.stack=self.stack[:i];break
    def handle_data(self,data):self.stack[-1].children.append(data)
class Word:
    def __init__(self,meta):self.media={};self.rels=[];self.warnings=set();self.meta=meta
    def rel(self,kind,target,external=False):
        rid='rId'+str(len(self.rels)+1);self.rels.append((rid,kind,target,external));return rid
    def inline(self,n,marks=()):
        if isinstance(n,str):
            out=[]
            for i,line in enumerate(n.split('\n')):
                if i:out.append(node('w:r',node('w:br')))
                if line:out.append(text_run(line,marks))
            return out
        if n.attrs.get('class')=='math':
            source=n.text.strip().strip('$').strip()
            try:return [equation(source)]
            except (ValueError,RecursionError):
                self.warnings.add('Some equation syntax could not be converted to Word maths. Its exact LaTeX source is included below; PDF keeps the rendered appearance.')
                return [text_run('[Equation source: '+source+']',marks)]
        extra={'strong':('b','1'),'b':('b','1'),'em':('i','1'),'i':('i','1'),'u':('u','single'),'del':('strike','1'),'s':('strike','1'),'mark':('highlight','yellow'),'code':('rFonts','Consolas')}.get(n.tag)
        if extra and n.tag!='code':marks=(*marks,extra)
        if n.tag=='br':return [node('w:r',node('w:br'))]
        if n.tag=='input' and n.attrs.get('type')=='checkbox':return [text_run('☑ ' if 'checked' in n.attrs else '☐ ',marks)]
        if n.tag=='img':return self.image(n)
        children=[r for c in n.children for r in self.inline(c,marks)]
        href=n.attrs.get('href','')
        if n.tag=='a' and re.match(r'^(https?://|mailto:)',href):
            h=E.Element('{%s}hyperlink'%W,{'{%s}id'%R:self.rel('hyperlink',href,True)});h.extend(children);return [h]
        return children
    def para(self,children,style=None,list_kind=None,level=0):
        p=node('w:p');props=node('w:pPr')
        if style:props.append(node('w:pStyle',val=style))
        if list_kind:props.append(node('w:numPr',node('w:ilvl',val=min(level,8)),node('w:numId',val=1 if list_kind=='ol' else 2)))
        p.append(props)
        for c in children:p.extend(self.inline(c))
        return p
    def blocks(self,n,level=0):
        if isinstance(n,str):return [self.para([n])] if n.strip() else []
        if n.tag=='table':
            table=node('w:tbl',node('w:tblPr',node('w:tblW',w=5000,type='pct'),node('w:tblBorders',*[node('w:'+side,val='single',sz=6,color='777777') for side in ('top','left','bottom','right','insideH','insideV')])))
            def rows(parent):
                for c in parent.children:
                    if not isinstance(c,str):
                        if c.tag=='tr':yield c
                        elif c.tag in ('tbody','thead','tfoot'):yield from rows(c)
            for row in rows(n):
                tr=node('w:tr')
                for cell in row.children:
                    if isinstance(cell,str) or cell.tag not in ('td','th'):continue
                    tc=node('w:tc');pr=node('w:tcPr')
                    if cell.tag=='th':pr.append(node('w:shd',fill='EEEEEE'))
                    tc.append(pr);tc.append(self.para(cell.children));tr.append(tc)
                table.append(tr)
            return [table,self.para([])]
        if n.tag in ('ul','ol'):
            out=[]
            for li in n.children:
                if not isinstance(li,Html) or li.tag!='li':continue
                inline=[c for c in li.children if isinstance(c,str) or c.tag not in ('ul','ol','p')]
                paragraphs=[c for c in li.children if isinstance(c,Html) and c.tag=='p']
                out.append(self.para(paragraphs[0].children if paragraphs else inline,list_kind=n.tag,level=level))
                for c in paragraphs[1:]:out.append(self.para(c.children))
                for c in li.children:
                    if isinstance(c,Html) and c.tag in ('ul','ol'):out.extend(self.blocks(c,level+1))
            return out
        if n.tag in ('p','h1','h2','h3','h4','h5','h6','pre') or n.attrs.get('class')=='math':return [self.para([n],('Heading'+n.tag[1]) if re.fullmatch('h[1-6]',n.tag) else None)]
        if n.tag=='img':return [self.para([n])]
        if n.tag in ('script','style'):return []
        out=[];pending=[]
        for c in n.children:
            if isinstance(c,str) or c.tag in ('span','a','strong','em','u','mark','code','br'):
                pending.append(c);continue
            if pending:out.append(self.para(pending));pending=[]
            out.extend(self.blocks(c,level))
        if pending and any(c.strip() if isinstance(c,str) else True for c in pending):out.append(self.para(pending))
        return out
    def image(self,n):
        source=n.attrs.get('src','');match=re.fullmatch(r'data:(image/(?:png|jpeg|gif|svg\+xml));base64,([A-Za-z0-9+/=\s]+)',source)
        if not match:self.warnings.add('An image could not be embedded. Its original stays in Cortex. Use PDF for exact appearance.');return [text_run('[Image: '+n.attrs.get('alt','original kept in Cortex')+']')]
        data=base64.b64decode(match[2],validate=False)
        if len(data)>20_000_000:raise ValueError('An image is too large for Word export; use PDF or reduce the image size.')
        mime=match[1];ext={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/svg+xml':'svg'}[mime]
        width,height=700,400
        if ext=='png' and data.startswith(b'\x89PNG') and len(data)>=24:width,height=struct.unpack('>II',data[16:24])
        if ext=='gif' and len(data)>=10:width,height=struct.unpack('<HH',data[6:10])
        if ext=='jpg' and data.startswith(b'\xff\xd8'):
            offset=2
            while offset+8<len(data):
                if data[offset]!=255:break
                marker=data[offset+1];length=int.from_bytes(data[offset+2:offset+4],'big')
                if marker in (192,193,194,195,197,198,199,201,202,203,205,206,207):height,width=struct.unpack('>HH',data[offset+5:offset+9]);break
                if length<2:break
                offset+=2+length
        if ext=='svg':
            svg=E.fromstring(data)
            if svg.tag.split('}')[-1]!='svg':raise ValueError('The SVG image is not valid')
            if svg.get('viewBox'):
                box=svg.get('viewBox').replace(',',' ').split()
                if len(box)==4:width,height=float(box[2]),float(box[3])
            allowed={'svg','g','defs','pattern','path','line','polyline','polygon','rect','circle','ellipse','text','tspan','title'}
            for parent in list(svg.iter()):
                for child in list(parent):
                    if child.tag.split('}')[-1] not in allowed:parent.remove(child)
                for key,value in list(parent.attrib.items()):
                    if key.lower().startswith('on') or 'href' in key or ('url(' in value and not re.fullmatch(r'url\(#[\w-]+\)',value)):del parent.attrib[key]
            data=E.tostring(svg)
            self.warnings.add('Vector graphs and sketches need a current version of Word. Use PDF if a vector preview is unavailable.')
        index=len(self.media)+1;name=f'image{index}.{ext}';self.media[name]=(mime,data);rid=self.rel('image','media/'+name)
        fallback=rid
        if ext=='svg':
            png='fallback.png';self.media[png]=('image/png',fallback_png());fallback=self.rel('image','media/'+png)
        cx=min(5486400,int(max(1,width)*9525));cy=max(91440,min(7315200,int(cx*max(1,height)/max(1,width))))
        drawing=node('w:drawing');inline=node('wp:inline',node('wp:extent',cx=cx,cy=cy),node('wp:docPr',id=index,name=n.attrs.get('alt') or 'Cortex figure'))
        # DrawingML namespaced attributes differ from WordprocessingML's qualified ones.
        for element in inline:
            element.attrib={k.split('}')[-1]:v for k,v in element.attrib.items()}
        graphic=node('a:graphic');gd=E.SubElement(graphic,'{%s}graphicData'%A,{'uri':PIC});pic=node('pic:pic');nv=node('pic:nvPicPr');E.SubElement(nv,'{%s}cNvPr'%PIC,{'id':str(index),'name':name});E.SubElement(nv,'{%s}cNvPicPr'%PIC);pic.append(nv)
        fill=node('pic:blipFill');blip=E.SubElement(fill,'{%s}blip'%A,{'{%s}embed'%R:fallback})
        if ext=='svg':
            extlst=E.SubElement(blip,'{%s}extLst'%A);extension=E.SubElement(extlst,'{%s}ext'%A,{'uri':'{96DAC541-7B7A-43D3-8B79-37D633B846F1}'});E.SubElement(extension,'{%s}svgBlip'%NS['asvg'],{'{%s}embed'%R:rid})
        fill.append(node('a:stretch',node('a:fillRect')));pic.append(fill)
        shape=node('pic:spPr');xf=node('a:xfrm');E.SubElement(xf,'{%s}off'%A,{'x':'0','y':'0'});E.SubElement(xf,'{%s}ext'%A,{'cx':str(cx),'cy':str(cy)});shape.append(xf);geometry=E.SubElement(shape,'{%s}prstGeom'%A,{'prst':'rect'});E.SubElement(geometry,'{%s}avLst'%A);pic.append(shape);gd.append(pic);inline.append(graphic);drawing.append(inline);return [node('w:r',drawing)]
    def finish(self,title,body):
        doc=node('w:document');b=node('w:body',self.para([title],'Title'),*self.blocks(Tree(body).root))
        for warning in sorted(self.warnings):b.append(self.para(['Export note: '+warning]))
        b.append(node('w:sectPr',node('w:pgSz',w=11906,h=16838),node('w:pgMar',top=1134,right=1134,bottom=1134,left=1134,header=567,footer=567,gutter=0)));doc.append(b)
        style=self.meta.get('documentStyle',{});style=style if isinstance(style,dict) else {}
        font={'serif':'Georgia','sans':'Segoe UI','mono':'Consolas'}.get(style.get('font') if isinstance(style.get('font'),str) else '', 'Calibri');size=style.get('size',16);size=size if size in (14,16,18,20,24) else 16
        styles=node('w:styles',node('w:docDefaults',node('w:rPrDefault',node('w:rPr',node('w:rFonts',ascii=font,hAnsi=font),node('w:sz',val=int(size*1.5))))))
        for name,points in [('Title',22),('Heading1',20),('Heading2',17),('Heading3',15),('Heading4',14),('Heading5',13),('Heading6',12)]:
            st=node('w:style',node('w:name',val=name),node('w:rPr',node('w:b'),node('w:sz',val=points*2)),type='paragraph',styleId=name);styles.append(st)
        self.rel('styles','styles.xml');self.rel('numbering','numbering.xml')
        numbering=node('w:numbering')
        for num,fmt,char in [(1,'decimal','%1.'),(2,'bullet','•')]:
            abstract=node('w:abstractNum',abstractNumId=num)
            for level in range(9):abstract.append(node('w:lvl',node('w:start',val=1),node('w:numFmt',val=fmt),node('w:lvlText',val=f'%{level+1}.' if num==1 else char),node('w:pPr',node('w:ind',left=720*(level+1),hanging=360)),ilvl=level))
            numbering.append(abstract);numbering.append(node('w:num',node('w:abstractNumId',val=num),numId=num))
        relns='http://schemas.openxmlformats.org/package/2006/relationships';relationships=E.Element('Relationships',{'xmlns':relns})
        for rid,kind,target,external in self.rels:
            attrs={'Id':rid,'Type':R+'/'+kind,'Target':target}
            if external:attrs['TargetMode']='External'
            E.SubElement(relationships,'Relationship',attrs)
        types=E.Element('Types',{'xmlns':'http://schemas.openxmlformats.org/package/2006/content-types'})
        for ext,mime in [('rels','application/vnd.openxmlformats-package.relationships+xml'),('xml','application/xml')]:E.SubElement(types,'Default',{'Extension':ext,'ContentType':mime})
        for part,mime in [('document','document.main'),('styles','styles'),('numbering','numbering')]:E.SubElement(types,'Override',{'PartName':f'/word/{part}.xml','ContentType':'application/vnd.openxmlformats-officedocument.wordprocessingml.'+mime+'+xml'})
        for ext,mime in {name.rsplit('.',1)[-1]:mime for name,(mime,_) in self.media.items()}.items():E.SubElement(types,'Default',{'Extension':ext,'ContentType':mime})
        out=io.BytesIO()
        with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
            for name,data in {'[Content_Types].xml':xml(types),'_rels/.rels':f'<Relationships xmlns="{relns}"><Relationship Id="rId1" Type="{R}/officeDocument" Target="word/document.xml"/></Relationships>'.encode(),'word/document.xml':xml(doc),'word/styles.xml':xml(styles),'word/numbering.xml':xml(numbering),'word/_rels/document.xml.rels':xml(relationships)}.items():z.writestr(name,data)
            for name,(_,data) in self.media.items():z.writestr('word/media/'+name,data)
        return out.getvalue()
def export_note(vault,rel):
    p=vault.resolve(rel)
    if p.suffix.lower()!='.md' or not p.is_file():raise ValueError('Choose a page to export')
    e=vault.entry(p);ctx=publish.SingleContext(vault,vault.entries());body=publish.Renderer(ctx,seen=frozenset({e.rel})).render(e.body)
    return Word(e.meta).finish(p.stem,body)
