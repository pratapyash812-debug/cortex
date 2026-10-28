import sys,unittest,re
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import folder_import,readable_import
from word_fixtures import docx,p,pack,image

class ReadableSectionsTests(unittest.TestCase):
    def test_slide_picture_with_package_absolute_relationship(self):
        a,r,rel=folder_import.course.A,folder_import.course.R,folder_import.course.REL
        png=image((30,60,100))
        source=pack({'ppt/slides/slide1.xml':f'<p:sld xmlns:p="urn:p" xmlns:a="{a}" xmlns:r="{r}"><a:blip r:embed="picture"/></p:sld>',
            'ppt/slides/_rels/slide1.xml.rels':f'<Relationships xmlns="{rel}"><Relationship Id="picture" Target="/ppt/media/graph.png"/></Relationships>',
            'ppt/media/graph.png':png})
        result=folder_import.convert_upload(source,'Absolute picture.pptx')
        self.assertTrue(any(value==png for key,value in result.items() if '/attachments/' in key))
        self.assertIn('![[Imported notes/Notes/attachments/',result['Imported notes/Notes/Absolute picture.pptx.md'])

    def test_chapter_names_skip_repeated_website_headers(self):
        from import_common import Names
        body='\n\n'.join(f'# [**Business economics**](https://example.invalid)\n\n## {i}. Actual chapter\n\n'+('Study text '*1000) for i in range(6))
        output={};index,children=readable_import.section_notes('Book.md',body,{},Names(),output)
        self.assertTrue(children)
        self.assertTrue(any('Actual chapter' in child for child in children))
        self.assertFalse(any('example.invalid' in child or 'Business economics' in child for child in children))

    def test_large_word_preserves_last_paragraph_in_real_grouped_sections(self):
        paragraphs=[f'Paragraph {i}: dækningsbidrag '+('meaning '*35) for i in range(1200)]
        source=docx(''.join(p(text) for text in paragraphs))
        result=folder_import.convert_upload(source,'Course book.docx')
        parent='Imported notes/Notes/Course book.docx.md';children=result['__notebooks__'][parent]
        self.assertGreater(len(children),10)
        text='\n'.join(result[path] for path in children)
        self.assertEqual([int(value) for value in re.findall(r'Paragraph (\d+):',text)],list(range(1200)))
        self.assertNotIn('shortened',result[parent])
        self.assertEqual(result['Imported notes/Sources/Course book.docx'],source)
        self.assertIn(parent,result['__notebooks__']['Imported notes/Imported notes.md'])

    def test_math_and_fenced_code_are_not_cut_between_sections(self):
        math='$$\nx=1\n\ny=2\n$$'
        code='```python\n'+('value = 1\n\n'*20)+'```'
        blocks=['# Chapter','Intro '*20,math,code,'# Last','End '*20]
        parts=readable_import.sections('\n\n'.join(blocks),limit=100)
        self.assertTrue(any(math in part for part in parts));self.assertTrue(any(code in part for part in parts))
        self.assertTrue(all(part.count('```')%2==0 for part in parts))

    def test_slide_run_spacing_table_picture_and_native_chart_notice(self):
        a,r,rel=folder_import.course.A,folder_import.course.R,folder_import.course.REL
        png=image((10,80,170))
        source=pack({'ppt/slides/slide1.xml':f'<p:sld xmlns:p="urn:p" xmlns:a="{a}" xmlns:r="{r}" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><a:p><a:r><a:t>Contribution </a:t></a:r><a:r><a:t>margin</a:t></a:r></a:p><a:tbl><a:tr><a:tc><a:p><a:r><a:t>Year</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>Revenue</a:t></a:r></a:p></a:tc></a:tr><a:tr><a:tc><a:p><a:r><a:t>2026</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>3000</a:t></a:r></a:p></a:tc></a:tr></a:tbl><a:blip r:embed="img"/><c:chart r:id="chart"/></p:sld>',
          'ppt/slides/_rels/slide1.xml.rels':f'<Relationships xmlns="{rel}"><Relationship Id="img" Target="../media/graph.png"/><Relationship Id="external" TargetMode="External" Target="https://example.invalid/tracker.png"/></Relationships>',
          'ppt/media/graph.png':png})
        result=folder_import.convert_upload(source,'Lecture.pptx')
        text=result['Imported notes/Notes/Lecture.pptx.md']
        self.assertIn('Contribution margin',text);self.assertIn('| 2026 | 3000 |',text)
        self.assertTrue(any(value==png for key,value in result.items() if '/attachments/' in key))
        self.assertIn('![[Imported notes/Notes/attachments/',text)
        self.assertTrue(any('native chart' in warning for warning in result['__warnings__']))
        self.assertNotIn('tracker.png',text)

    def test_html_becomes_readable_text_without_executing_or_embedding_remote_images(self):
        source=b'<h1>Exam notes</h1><p>Revenue means sales.</p><script>BAD_SCRIPT()</script><img src="https://example.invalid/pixel" alt="Class diagram">'
        result=folder_import.convert_upload(source,'Exam.html')
        note=result['Imported notes/Notes/Exam.html.md']
        self.assertIn('# Exam notes',note);self.assertIn('Revenue means sales.',note)
        self.assertNotIn('BAD_SCRIPT',note);self.assertNotIn('https://example.invalid',note)
        self.assertEqual(result['Imported notes/Sources/Exam.html.txt'],source)

if __name__=='__main__':unittest.main()
