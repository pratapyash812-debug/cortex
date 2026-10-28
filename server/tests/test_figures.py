"""Real render/storage/HTTP contracts for study figures; no model or network service."""
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request,urlopen
import xml.etree.ElementTree as ET
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
import figures
import server

class FigureTests(unittest.TestCase):
 def test_real_math_precedence_unicode_and_domains(self):
  for source,x,y in [('y = x² + 2x',3,15),('sin(pi/2)',0,1),('ln(e)',0,1),('-x^2',3,-9),('x^2^2',2,16)]:
   with self.subTest(source=source):self.assertAlmostEqual(figures.expression(source)[1](x),y)
  self.assertIsNone(figures.expression('sqrt(x)')[1](-1))
  self.assertIsNone(figures.expression('1/x')[1](0))
 def test_expressions_cannot_execute_or_allocate_python(self):
  for source in ["__import__('os')",'x.__class__','[x]*999999','(lambda:1)()','x if x else 1','open(1)','True','sin(x,2)','x[0]']:
   with self.subTest(source=source),self.assertRaises(ValueError):figures.expression(source)
 def test_function_render_and_undefined_values_are_valid_svg(self):
  result=figures.render({'kind':'function','expressions':['1/x','sqrt(x)','sin(x)'],'xMin':-5,'xMax':5,'title':'Functions'})
  ET.fromstring(result['svg']);self.assertNotIn('nan',result['svg'].lower());self.assertNotIn('inf ',result['svg'].lower())
  self.assertIn('1/x',result['summary'])
 def test_bad_or_empty_ranges_are_explicit(self):
  for cfg in [{'xMin':5,'xMax':1},{'xMin':None},{'xMax':float('inf')},{'expressions':['sqrt(-1)']},{'expressions':[]}]:
   with self.subTest(cfg=cfg),self.assertRaises(ValueError):figures.render({'kind':'function',**cfg})
 def test_chart_excel_thousands_decimal_comma_and_missing_cells(self):
  header,rows=figures.data_rows('Year\tValue\tMargin\n2024\t1.200\t12,5%\n2025\t\t15%',True)
  self.assertEqual(header,['Year','Value','Margin']);self.assertEqual(rows,[('2024',[1200,12.5]),('2025',[None,15])])
  self.assertEqual(figures.data_rows('Year,Value\n2024,"1,200"')[1][0][1],[1200])
 def test_malformed_cells_never_become_zero(self):
  for data in ['Year,Value\n2024,nope','Year,Value\n2024,1,2','Year,Value\n2024,NaN','Year,Value\n2024,']:
   with self.subTest(data=data),self.assertRaises(ValueError):figures.data_rows(data)
 def test_line_single_point_and_negative_bars_are_visible(self):
  one=figures.render({'kind':'line','data':'Year,Revenue\n2024,120'})
  self.assertIn('<circle ',one['svg'])
  # A valid steep data series must stay connected; pole detection is only for functions.
  steep=figures.render({'kind':'line','data':'Year,Revenue\n2024,0\n2025,100'})
  self.assertRegex(steep['svg'],r'<path d="M[0-9.]+ [0-9.]+ L[0-9.]+ [0-9.]+" stroke="#747bff"')
  bars=figures.render({'kind':'bar','data':'Year,Profit,Cost\n2024,-20,30\n2025,40,50'})
  root=ET.fromstring(bars['svg']);rects=root.findall('.//{http://www.w3.org/2000/svg}rect')
  self.assertGreaterEqual(len(rects),5)
  for rect in rects[1:]:self.assertGreater(float(rect.attrib['height']),0)
 def test_labels_are_xml_text_not_active_content(self):
  result=figures.render({'kind':'diagram','title':'<script>alert(1)</script>','steps':['<img onerror="bad">','A & B']})
  root=ET.fromstring(result['svg']);self.assertNotIn('<script>',result['svg']);self.assertIn('&lt;script&gt;',result['svg'])
  self.assertFalse(any(node.tag.endswith('script') for node in root.iter()))
 def test_preview_limits_are_bounded(self):
  with self.assertRaises(ValueError):figures.data_rows('Label,Value\n'+'a,1\n'*201)
  with self.assertRaises(ValueError):figures.render({'kind':'function','expressions':['x']*5})
 def test_edit_source_and_images_are_portable_immutable_snapshots(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);first=figures.save(root,{'kind':'function','expressions':['x^2']});original=(root/first['image']).read_bytes()
   second=figures.save(root,{'kind':'function','expressions':['x^3']})
   self.assertNotEqual(first['id'],second['id']);self.assertEqual((root/first['image']).read_bytes(),original)
   self.assertEqual(figures.read(root,first['id'])['config']['expressions'],['x**2'])
   self.assertEqual(first['markdown'],f'![[{first["image"]}]]')
   self.assertTrue((root/'.cortex/figures'/f'{first["id"]}.json').is_file())
   with self.assertRaises(ValueError):figures.read(root,'../../private')

class FigureHttpTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
  self.httpd=server.make_server(str(self.root),0,background_ai=False,watch=False,background_sync=False,background_reminders=False)
  self.thread=threading.Thread(target=self.httpd.serve_forever,daemon=True);self.thread.start()
  self.url=f'http://127.0.0.1:{self.httpd.server_port}'
 def tearDown(self):self.httpd.shutdown();self.httpd.server_close();self.thread.join(2);self.temp.cleanup()
 def request(self,method,path,body=None,raw=False):
  req=Request(self.url+path,method=method,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'})
  try:r=urlopen(req,timeout=5)
  except HTTPError as e:r=e
  with r:
   content=r.read();return r.status,content if raw else json.loads(content)
 def test_preview_never_creates_files(self):
  before={p.relative_to(self.root) for p in self.root.rglob('*')}
  status,data=self.request('POST','/api/figures/preview',{'kind':'function','expressions':['x²']})
  self.assertEqual(status,200);ET.fromstring(data['svg']);self.assertEqual(before,{p.relative_to(self.root) for p in self.root.rglob('*')})
 def test_full_note_image_and_offline_html_round_trip(self):
  _,note=self.request('POST','/api/note',{'title':'Economics','content':'Before.\n\nAfter.'})
  status,saved=self.request('POST','/api/figures',{'path':note['path'],'config':{'kind':'bar','title':'Profit','data':'Year,Profit\n2024,-20\n2025,40'}})
  self.assertEqual(status,200,saved)
  status,updated=self.request('PUT','/api/note',{'path':note['path'],'content':'Before.\n\n'+saved['markdown']+'\n\nAfter.','baseRevision':note['revision']})
  self.assertEqual(status,200,updated)
  _,read=self.request('GET','/api/note?path='+quote(note['path']))
  self.assertEqual(read['attachments'][saved['image']],saved['image'])
  status,image=self.request('GET','/files/'+quote(saved['image']),raw=True);self.assertEqual(status,200);ET.fromstring(image)
  status,export=self.request('GET','/api/export/html?path='+quote(note['path']),raw=True)
  self.assertEqual(status,200);self.assertIn(b'data:image/svg+xml;base64,',export)
 def test_inline_canvas_note_exports_saved_sketch_without_rewriting_either_file(self):
  import base64,re
  _,canvas=self.request('POST','/api/canvas',{'title':'Inline sketch'})
  stroke={'id':'axis','color':'#e5484d','width':4,'points':[0,0,100,0,100,-70]}
  self.assertEqual(self.request('PUT','/api/canvas/drawing',{'path':canvas['path'],'strokes':[stroke]})[0],200)
  _,note=self.request('POST','/api/note',{'title':'Inline lesson','content':'Before.\n\n![[%s]]\n\nAfter.'%canvas['path']})
  body=(self.root/note['path']).read_bytes();drawing=(self.root/canvas['path']).read_bytes()
  status,export=self.request('GET','/api/export/html?path='+quote(note['path']),raw=True)
  self.assertEqual(status,200);match=re.search(rb'data:image/svg\+xml;base64,([^\"]+)',export);self.assertIsNotNone(match)
  svg=base64.b64decode(match[1]);ET.fromstring(svg);self.assertIn(b'M0.0 0.0 L100.0 0.0 L100.0 -70.0',svg)
  self.assertEqual((self.root/note['path']).read_bytes(),body);self.assertEqual((self.root/canvas['path']).read_bytes(),drawing)
  self.assertNotIn(b'<script',figures.sketch_svg([stroke],'<script>bad</script>').encode())

 def test_deleted_note_rejects_new_asset_without_writing(self):
  status,error=self.request('POST','/api/figures',{'path':'Missing.md','config':{'kind':'function'}})
  self.assertEqual(status,400);self.assertIn('Reopen the note',error['error']);self.assertFalse((self.root/'attachments/figures').exists())

if __name__=='__main__':unittest.main()
