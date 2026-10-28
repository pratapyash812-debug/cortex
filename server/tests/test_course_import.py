"""Course libraries retain original formats and bounded, correctly linked notes."""
import io
import re
import sys
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
import course_import
from word_fixtures import docx, p, pack

def pptx(count=3):
    a=course_import.A
    return pack({f'ppt/slides/slide{number}.xml':f'<p:sld xmlns:p="urn:fixture" xmlns:a="{a}"><a:t>Topic {number}</a:t></p:sld>' for number in range(1,count+1)})

def xlsx():
    s,r,rel=course_import.S,course_import.R,course_import.REL
    return pack({'xl/workbook.xml':f'<workbook xmlns="{s}" xmlns:r="{r}"><sheets><sheet name="Profit &amp; loss" sheetId="1" r:id="r1"/><sheet name="Balance" sheetId="2" r:id="r2"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':f'<Relationships xmlns="{rel}"><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml':f'<worksheet xmlns="{s}"><dimension ref="A1:C5"/><sheetData><row r="1"><c r="A1"><v>100</v></c><c r="B1"><f>A1*2</f><v>200</v></c><c r="C1"><f>SUM(A1:B1)</f><v>300</v></c></row></sheetData></worksheet>',
      'xl/worksheets/sheet2.xml':f'<worksheet xmlns="{s}"><sheetData><row r="1"><c r="A1"><f>\'Profit &amp; loss\'!C1</f><v>300</v></c></row></sheetData></worksheet>'})


class CourseImportTests(unittest.TestCase):
    def test_mixed_course_folder_exact_originals_hierarchy_and_index(self):
        sources={'School/Maths/Algebra.docx':docx(p('Algebra')+p('Student notes')),
          'School/Economics/Lesson.pptx':pptx(), 'School/Economics/Calculations.xlsx':xlsx(),
          'School/Economics/Handout.pdf':b'%PDF-1.7\nfixture retained without inferring pages'}
        result=course_import.convert_upload(pack(sources),'School.zip','Course import 2')
        for relative,blob in sources.items():
            source='Course import 2/Sources/'+relative
            companion='Course import 2/Notes/'+relative+'.md'
            self.assertEqual(result[source],blob)
            self.assertIn('[['+source+']]',result[companion])
            self.assertIn('[['+companion+'|',result['Course import 2/Course index.md'])
        self.assertEqual(result['__stats__']['sources'],4)
        self.assertEqual(result['__stats__']['notes'],5)
        self.assertTrue(all(len(text)<=course_import.MAX_NOTE_CHARS for path,text in result.items() if isinstance(text,str) and path.endswith('.md') and not path.endswith('Course index.md')))

    def test_powerpoint_slide_order_locators_and_preview_limit(self):
        result=course_import.convert_upload(pptx(40),'Lectures.pptx')
        note=result['Course import/Notes/Lectures.pptx.md']
        self.assertIn('40 slides',note)
        self.assertIn('- Slide 10: Topic 10',note)
        self.assertLess(note.index('- Slide 2:'),note.index('- Slide 10:'))
        self.assertIn('first 32 of 40 slides',note)
        self.assertNotIn('- Slide 33:',note)

    def test_workbook_formulas_preserved_counted_without_recalculation(self):
        source=xlsx()
        result=course_import.convert_upload(source,'Formulas.xlsx')
        self.assertEqual(result['Course import/Sources/Formulas.xlsx'],source)
        note=result['Course import/Notes/Formulas.xlsx.md']
        self.assertIn('Profit & loss',note)
        self.assertIn('2 stored formula cells',note)
        self.assertIn('1 stored formula cells',note)
        self.assertIn('A1:C5',note)
        self.assertIn('No calculation or correctness check was performed',note)
        self.assertNotIn('A1*2',note)

    def test_huge_word_source_yields_small_companion_not_body_copy(self):
        source=docx(''.join(p('Large source paragraph '+str(number)+' '+('content '*25)) for number in range(6000)))
        result=course_import.convert_upload(source,'Textbook.docx')
        note=result['Course import/Notes/Textbook.docx.md']
        self.assertEqual(result['Course import/Sources/Textbook.docx'],source)
        self.assertIn('6,000 nonempty paragraphs',note)
        self.assertLess(len(note),2500)
        self.assertNotIn('paragraph 5999',note)

    def test_pdf_does_not_invent_page_count(self):
        source=b'%PDF original fixture'
        result=course_import.convert_upload(source,'Reader.pdf')
        note=result['Course import/Notes/Reader.pdf.md']
        self.assertEqual(result['Course import/Sources/Reader.pdf'],source)
        self.assertIn('does not extract or infer a page count',note)
        self.assertNotRegex(note,r'\d+ pages')

    def test_legacy_sources_and_html_safe_text_bytes_retained(self):
        sources={'Old.xls':b'xls','Old.ppt':b'ppt','Old.doc':b'doc','Article.html':b'<script>DO_NOT_EXECUTE()</script>'}
        result=course_import.convert_upload(pack(sources),'Mixed.zip')
        for filename,blob in sources.items():
            target=filename+'.txt' if filename.endswith('.html') else filename
            self.assertEqual(result['Course import/Sources/'+target],blob)
        self.assertNotIn('Course import/Sources/Article.html',result)
        self.assertIn('Scripts, embedded pages and external links were not executed',result['Course import/Notes/Article.html.md'])
        self.assertEqual(result['__stats__']['preview_unsupported'],4)
        self.assertEqual(len(result['__warnings__']),4)

    def test_unreadable_office_preview_keeps_original_and_honest_warning(self):
        source=b'not a ZIP but must be retained'
        result=course_import.convert_upload(source,'Broken.docx')
        self.assertEqual(result['Course import/Sources/Broken.docx'],source)
        self.assertEqual(result['__stats__']['failed'],1)
        self.assertIn('Source preview unavailable',result['Course import/Notes/Broken.docx.md'])
        self.assertIn('Original bytes preserved',' '.join(result['__warnings__']))

    def test_unsafe_xml_is_not_expanded_and_source_still_retained(self):
        source=pack({'word/document.xml':'<!DOCTYPE x [<!ENTITY bad "DO_NOT_EXPAND">]><w:document xmlns:w="'+course_import.W+'"><w:body><w:p><w:r><w:t>&bad;</w:t></w:r></w:p></w:body></w:document>'})
        result=course_import.convert_upload(source,'Entity.docx')
        self.assertEqual(result['__stats__']['failed'],1)
        self.assertNotIn('DO_NOT_EXPAND',result['Course import/Notes/Entity.docx.md'])

    def test_archive_utf8_name_without_flag_is_losslessly_repaired(self):
        buffer=io.BytesIO()
        with zipfile.ZipFile(buffer,'w') as archive:
            archive.writestr('VØ/Æble.docx',docx(p('Dansk æøå')))
        # Alter the actual ZIP headers, rather than overriding a private
        # ZipInfo writer hook whose behaviour differs between Python versions.
        broken=bytearray(buffer.getvalue());end=broken.rfind(b'PK\x05\x06')
        central=int.from_bytes(broken[end+16:end+20],'little')
        self.assertEqual(broken[:4],b'PK\x03\x04');self.assertEqual(broken[central:central+4],b'PK\x01\x02')
        for offset in (6,central+8):
            flags=int.from_bytes(broken[offset:offset+2],'little')
            broken[offset:offset+2]=(flags&~0x800).to_bytes(2,'little')
        with zipfile.ZipFile(io.BytesIO(broken)) as archive:
            self.assertFalse(archive.infolist()[0].flag_bits&0x800)
            self.assertNotEqual(archive.infolist()[0].filename,'VØ/Æble.docx')
        result=course_import.convert_upload(bytes(broken),'Course.zip')
        self.assertIn('Course import/Sources/VØ/Æble.docx',result)
        self.assertTrue(any('filename encoding repaired' in message for message in result['__warnings__']))

    def test_case_sanitization_device_and_file_folder_collisions(self):
        sources={'A:B/Sheet.xlsx':xlsx(),'A?B/Sheet.xlsx':xlsx(),'Case/Word.docx':docx(p('a')),
          'case/Word.docx':docx(p('b')),'Exam.docx':docx(p('c')),'Exam.docx/Inside.docx':docx(p('d')),'CON.txt':b'text'}
        result=course_import.convert_upload(pack(sources),'Cases.zip')
        paths=[path for path in result if not path.startswith('__')]
        self.assertEqual(len(paths),len(set(path.lower() for path in paths)))
        self.assertIn('Course import/Sources/Exam 2.docx',paths)
        self.assertIn('Course import/Sources/_CON.txt',paths)
        self.assertEqual(result['__stats__']['sources'],7)
        for path in paths:
            if path.endswith('.md'):
                for link in re.findall(r'\[\[([^]|]+)(?:\|[^]]+)?\]\]',result[path]):
                    self.assertIn(link,result)

    def test_macros_executables_metadata_and_escapes_are_not_imported(self):
        source=pack({'Good.csv':b'Column,Value\nA,1','Run.exe':b'MZ','Macro.xlsm':b'macro','../Outside.pdf':b'%PDF','__MACOSX/._Good.csv':b'fork','~$busy.docx':b'lock','.DS_Store':b'finder'})
        result=course_import.convert_upload(source,'Course.zip')
        self.assertEqual(result['__stats__']['sources'],1)
        self.assertEqual(result['__stats__']['unsupported'],2)
        self.assertEqual(result['Course import/Sources/Good.csv'],b'Column,Value\nA,1')
        self.assertFalse(any(path.endswith(('.exe','.xlsm')) for path in result))

    def test_limits_fail_explicitly_without_partial_return(self):
        source=pack({'One.txt':b'one','Two.txt':b'two'})
        with patch.object(course_import,'MAX_SOURCES',1),self.assertRaisesRegex(ValueError,'at most 1'):
            course_import.convert_upload(source,'Many.zip')
        with patch.object(course_import,'MAX_INDEX_CHARS',1),self.assertRaisesRegex(ValueError,'index would be too large'):
            course_import.convert_upload(b'one','One.txt')
        with patch.object(course_import,'MAX_XML_BYTES',1):
            result=course_import.convert_upload(docx(p('body')),'Large.docx')
            self.assertEqual(result['__stats__']['failed'],1)
            self.assertEqual(result['__stats__']['sources'],1)

    def test_all_unsupported_or_invalid_destination_fail(self):
        with self.assertRaisesRegex(ValueError,'No supported course materials'):
            course_import.convert_upload(pack({'Run.exe':b'exe'}),'Bad.zip')
        for destination in ('../escape','C:/escape','/absolute'):
            with self.subTest(destination=destination),self.assertRaises(ValueError):
                course_import.convert_upload(b'text','Note.txt',destination)


if __name__=='__main__':
    unittest.main()
