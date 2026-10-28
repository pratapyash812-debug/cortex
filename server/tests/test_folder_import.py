"""Readable folder import preserves the exact sources and actual lesson content."""
import json,sys,tempfile,threading,unittest,urllib.request
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import folder_import,server
from word_fixtures import docx,p,pack
from test_course_import import xlsx

class ReadableFolderTests(unittest.TestCase):
    def test_word_is_editable_content_beyond_the_old_overview(self):
        source=docx(''.join(p(f'Business paragraph {i} dækningsbidrag') for i in range(10)))
        result=folder_import.convert_upload(source,'Economics.docx')
        self.assertEqual(result['Imported notes/Sources/Economics.docx'],source)
        text=result['Imported notes/Notes/Economics.docx.md']
        self.assertIn('Business paragraph 9',text);self.assertIn('dækningsbidrag',text)
        self.assertIn('[[Imported notes/Sources/Economics.docx]]',text)
        self.assertNotIn('Use Word documents import',text)

    def test_presentation_contains_each_slide_body_not_just_its_title(self):
        a=folder_import.course.A
        source=pack({'ppt/slides/slide1.xml':f'<p:sld xmlns:p="urn:fixture" xmlns:a="{a}"><a:t>Demand</a:t><a:t>A higher price reduces quantity demanded.</a:t></p:sld>'})
        result=folder_import.convert_upload(source,'Lesson.pptx')
        self.assertIn('A higher price reduces quantity demanded.',result['Imported notes/Notes/Lesson.pptx.md'])
        self.assertEqual(result['Imported notes/Sources/Lesson.pptx'],source)

    def test_spreadsheet_shows_cached_values_and_does_not_recalculate(self):
        source=xlsx();result=folder_import.convert_upload(source,'Exercise.xlsx')
        note=result['Imported notes/Notes/Exercise.xlsx.md']
        self.assertIn('| 100 | 200 | 300 |',note)
        self.assertIn('Cached results may be out of date',note)
        self.assertIn('100 rows',note)
        self.assertEqual(result['Imported notes/Sources/Exercise.xlsx'],source)

    def test_pdf_embeds_reader_and_original_is_byte_identical(self):
        source=b'%PDF fixture';result=folder_import.convert_upload(source,'Chapter.pdf')
        self.assertIn('![[Imported notes/Sources/Chapter.pdf]]',result['Imported notes/Notes/Chapter.pdf.md'])
        self.assertEqual(result['Imported notes/Sources/Chapter.pdf'],source)

    def test_mixed_folder_preserves_hierarchy_and_reports_failed_conversion(self):
        sources={'School/Maths/Lesson.docx':docx(p('Solve x squared')),'School/Economics/Broken.docx':b'broken','School/English/Notes.txt':b'The complete paragraph.\nSecond paragraph.'}
        result=folder_import.convert_upload(pack(sources),'School.zip')
        for rel,content in sources.items():self.assertEqual(result['Imported notes/Sources/'+rel],content)
        self.assertIn('Second paragraph.',result['Imported notes/Notes/School/English/Notes.txt.md'])
        self.assertTrue(result['__warnings__'])
        self.assertIn('Source preview unavailable',result['Imported notes/Notes/School/Economics/Broken.docx.md'])

    def test_public_folder_import_and_subnote_routes_preserve_earlier_note(self):
        with tempfile.TemporaryDirectory() as temp:
            httpd=server.make_server(temp,0);thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start()
            base=f'http://127.0.0.1:{httpd.server_port}'
            def call(method,path,data=None):
                request=urllib.request.Request(base+path,data=None if data is None else json.dumps(data).encode(),method=method,headers={'Content-Type':'application/json'})
                with urllib.request.urlopen(request) as response:return json.load(response)
            try:
                original=server.Handler.vault.create('Maths','Lesson','Equation: x² + y² = 1')
                added=call('POST','/api/notebook',{'path':original['path'],'title':'Worked example'})
                sub=call('GET','/api/note?path='+urllib.parse.quote(added['created']))
                call('PUT','/api/note',{'path':sub['path'],'content':'Draw the circle here.','baseRevision':sub['revision']})
                self.assertEqual(call('GET','/api/note?path=Maths/Lesson.md')['content'],original['content'])
                self.assertEqual(len(call('GET','/api/notebook?path=Maths/Lesson.md')['sheets']),2)
                source=docx(p('A real imported lesson'))
                request=urllib.request.Request(base+'/api/import/folder?name=Lesson.docx',data=source,method='POST')
                with urllib.request.urlopen(request) as response:imported=json.load(response)
                root=Path(temp)/imported['folder']
                self.assertEqual((root/'Sources/Lesson.docx').read_bytes(),source)
                self.assertIn('A real imported lesson',(root/'Notes/Lesson.docx.md').read_text(encoding='utf-8'))
            finally:httpd.shutdown();httpd.server_close();thread.join(2)

if __name__=='__main__':unittest.main()
