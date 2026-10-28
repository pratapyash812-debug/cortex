"""Synthetic, complete OPC Word packages for local import QA; no downloaded data."""
from __future__ import annotations
import io
import struct
import zipfile
import zlib
from html import escape
from pathlib import Path

W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
M='http://schemas.openxmlformats.org/officeDocument/2006/math'
R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
A='http://schemas.openxmlformats.org/drawingml/2006/main'

def pack(files):
 output=io.BytesIO()
 with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as archive:
  for name,data in files.items(): archive.writestr(name,data)
 return output.getvalue()

def mt(text): return '<m:r><m:t>'+escape(text)+'</m:t></m:r>'
def p(text): return '<w:p><w:r><w:t xml:space="preserve">'+escape(text)+'</w:t></w:r></w:p>'
def inline(math): return '<m:oMath>'+math+'</m:oMath>'
def display(math): return '<w:p><m:oMathPara><m:oMath>'+math+'</m:oMath></m:oMathPara></w:p>'
def arg(name,content): return f'<m:{name}>{content}</m:{name}>'
def fraction(a,b): return '<m:f>'+arg('num',mt(a))+arg('den',mt(b))+'</m:f>'
def power(base,exponent): return '<m:sSup>'+arg('e',mt(base))+arg('sup',mt(exponent))+'</m:sSup>'

def image(rgb):
 def chunk(kind,data): return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
 raw=b''.join(b'\0'+bytes(rgb)*8 for _ in range(8))
 return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',8,8,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')

def picture():
 return '''<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Course graph"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rImage"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'''

def docx(body,rgb=None,created='2026-09-01T09:00:00Z'):
 document=f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{W}" xmlns:m="{M}" xmlns:r="{R}" xmlns:a="{A}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>'''
 files={'word/document.xml':document,
  '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>',
  '_rels/.rels':f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rMain" Type="{R}/officeDocument" Target="word/document.xml"/><Relationship Id="rCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
  'docProps/core.xml':f'<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Student fixture</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">{created}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-10-01T14:30:00Z</dcterms:modified><cp:keywords>revision;skole</cp:keywords></cp:coreProperties>'}
 if rgb is not None:
  files['word/media/image1.png']=image(rgb)
  files['word/_rels/document.xml.rels']=f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rImage" Type="{R}/image" Target="media/image1.png"/></Relationships>'
 return pack(files)

def course_files():
 matrix='<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr><m:e><m:m><m:mr>'+arg('e',mt('1'))+arg('e',mt('2'))+'</m:mr><m:mr>'+arg('e',mt('3'))+arg('e',mt('4'))+'</m:mr></m:m></m:e></m:d>'
 summation='<m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/></m:naryPr>'+arg('sub',mt('i=1'))+arg('sup',mt('n'))+arg('e','<m:sSub>'+arg('e',mt('x'))+arg('sub',mt('i'))+'</m:sSub>')+'</m:nary>'
 integral='<m:nary>'+arg('sub',mt('0'))+arg('sup',mt('1'))+arg('e',power('x','2')+mt('dx'))+'</m:nary>'
 radical='<m:rad>'+arg('deg',mt('3'))+arg('e',mt('x'))+'</m:rad>'
 function='<m:func>'+arg('fName',mt('ln'))+arg('e',mt('x'))+'</m:func>'+mt('+α+β')
 aligned='<m:eqArr>'+arg('e',mt('a&=b+c'))+arg('e',mt('d&=e+f'))+'</m:eqArr>'
 unsupported='<m:phant><m:phantPr><m:show m:val="1"/></m:phantPr>'+arg('e',mt('x + y (source retained)'))+'</m:phant>'
 math_body=p('Maths — Word equation workshop')+'<w:p><w:r><w:t xml:space="preserve">The ratio is </w:t></w:r>'+inline(fraction('a','b'))+'<w:r><w:t xml:space="preserve"> and the prose remains.</w:t></w:r></w:p>'+display(power('x','2')+mt('-6x+5=0'))+display(radical)+display(summation)+display(integral)+display(matrix)+display(aligned)+display(function)+display(unsupported)
 econ_body=p('IEcon — Supply and demand')+display(mt('P=100-2Q'))+p('A fall in price increases quantity demanded, holding other factors constant.')+picture()
 business_body=p('BEcon — Revenue and cost')+'<w:tbl><w:tr><w:tc>'+p('Measure')+'</w:tc><w:tc>'+p('Formula')+'</w:tc></w:tr><w:tr><w:tc>'+p('Average cost')+'</w:tc><w:tc>'+display(fraction('TC','Q'))+'</w:tc></w:tr></w:tbl>'+picture()
 return {'School/Maths/Quadratics.docx':docx(math_body),
  'School/IEcon/Lecture.docx':docx(econ_body,(30,80,220)),
  'School/BEcon/Lecture.docx':docx(business_body,(220,70,40)),
  'School/Marketing/Brand notes.docx':docx(p('Marketing — Brand positioning')+p('Identify the target audience, differentiator and evidence.')),
  'School/English/Close reading.docx':docx(p('English — Close reading')+p('Separate evidence from inference; retain exact quotations from the assigned passage.')),
  'School/Danish/Analyse.docx':docx(p('Dansk — Fortæller og synsvinkel')+p('Æble, øvelse, åbenhed. Æ Ø Å / æ ø å skal bevares.'))}

if __name__=='__main__':
 target=Path(__file__).resolve().parent/'fixtures'
 target.mkdir(exist_ok=True)
 docs=course_files()
 (target/'Student courses.zip').write_bytes(pack(docs))
 for source,data in docs.items():
  path=target/source
  path.parent.mkdir(parents=True,exist_ok=True)
  path.write_bytes(data)
 print(str(target/'Student courses.zip'))
