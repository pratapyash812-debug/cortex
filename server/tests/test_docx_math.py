"""Word's structural equations and a folder of course notes survive conversion."""
import io
import re
import sys
import unittest
import warnings
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import docx_import
import omml
from word_fixtures import M, W, arg, course_files, display, docx, fraction, image, inline, mt, p, pack, picture, power


def math(source):
    return ET.fromstring(f'<m:oMath xmlns:m="{M}" xmlns:w="{W}">{source}</m:oMath>')


def tex(source):
    result = omml.convert(math(source))
    if result.latex is None:
        raise AssertionError(result.warnings)
    return result.latex


class WordMathTests(unittest.TestCase):
    def test_inline_display_and_danish_prose_properties_survive(self):
        source = docx('<w:p><w:r><w:t xml:space="preserve">Før </w:t></w:r>'+inline(fraction('a','b'))+'<w:r><w:t xml:space="preserve"> efter æøå.</w:t></w:r></w:p>'+display(power('x','2')))
        result = docx_import.convert_upload(source,'Lesson.docx','Word import 7')
        note = result['Word import 7/Lesson.md']
        self.assertIn(r'Før $\frac{a}{b}$ efter æøå.',note)
        self.assertIn('$$\n{x}^{2}\n$$',note)
        self.assertIn('author: Student fixture',note)
        self.assertIn('created:',note)
        self.assertIn('Word import 7/Lesson.md',result['__mtimes__'])
        self.assertEqual(result['__stats__']['equations'],2)
        self.assertNotIn('__warnings__',result)

    def test_fraction_styles_scripts_and_roots(self):
        self.assertEqual(tex(fraction('a','b')),r'\frac{a}{b}')
        self.assertIn(r'\genfrac{}{}{0pt}',tex('<m:f><m:fPr><m:type m:val="noBar"/></m:fPr>'+arg('num',mt('n'))+arg('den',mt('k'))+'</m:f>'))
        self.assertEqual(tex('<m:sSubSup>'+arg('e',mt('x'))+arg('sub',mt('i'))+arg('sup',mt('2'))+'</m:sSubSup>'),r'{x}_{i}^{2}')
        self.assertEqual(tex('<m:sPre>'+arg('sub',mt('6'))+arg('sup',mt('14'))+arg('e',mt('C'))+'</m:sPre>'),r'{}_{6}^{14}{C}')
        self.assertEqual(tex('<m:rad>'+arg('deg',mt('3'))+arg('e',mt('x'))+'</m:rad>'),r'\sqrt[3]{x}')
        self.assertEqual(tex('<m:rad><m:radPr><m:degHide/></m:radPr>'+arg('deg',mt('3'))+arg('e',mt('x'))+'</m:rad>'),r'\sqrt{x}')

    def test_nary_defaults_hidden_limits_and_functions(self):
        expression=arg('sub',mt('0'))+arg('sup',mt('1'))+arg('e',mt('x dx'))
        self.assertEqual(tex('<m:nary>'+expression+'</m:nary>'),r'\int_{0}^{1}{x dx}')
        self.assertEqual(tex('<m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/><m:supHide/></m:naryPr>'+expression+'</m:nary>'),r'\sum\limits_{0}{x dx}')
        self.assertEqual(tex('<m:func>'+arg('fName',mt('ln'))+arg('e',mt('α+β'))+'</m:func>'),r'\ln {\alpha +\beta }')
        nested='<m:limLow>'+arg('e',mt('lim'))+arg('lim',mt('x→0'))+'</m:limLow>'
        self.assertIn(r'\underset{x\to 0}{\lim }',tex('<m:func>'+arg('fName',nested)+arg('e',mt('f(x)'))+'</m:func>'))

    def test_matrices_arrays_delimiters_and_table_math(self):
        matrix='<m:m><m:mr>'+arg('e',mt('1'))+arg('e',mt('2'))+'</m:mr><m:mr>'+arg('e',mt('3'))+arg('e',mt('4'))+'</m:mr></m:m>'
        self.assertEqual(tex(matrix),r'\begin{matrix}1 & 2 \\ 3 & 4\end{matrix}')
        self.assertIn(r'\begin{aligned}a&=b \\ c&=d',tex('<m:eqArr>'+arg('e',mt('a&=b'))+arg('e',mt('c&=d'))+'</m:eqArr>'))
        absolute='<m:d><m:dPr><m:begChr m:val="|"/><m:endChr m:val="|"/></m:dPr>'+arg('e',mt('x'))+'</m:d>'
        source=docx('<w:tbl><w:tr><w:tc>'+p('Formula')+'</w:tc></w:tr><w:tr><w:tc>'+display(absolute)+'</w:tc></w:tr></w:tbl>')
        note=docx_import.convert_upload(source,'Table.docx')['Word import/Table.md']
        self.assertIn(r'$\left\vert x\right\vert$',note)
        self.assertNotIn('$$',note)
        self.assertNotIn(r'\|',note)
        self.assertIn('| --- |',note)

    def test_literal_tex_cannot_become_a_command(self):
        literal=r'\href{https://invalid.test}{x} $ # % _ ^ ~ | & æ'
        rendered=tex(mt(literal))
        self.assertNotIn(r'\href',rendered)
        self.assertIn(r'\backslash href\{',rendered)
        self.assertIn(r'\$ \# \% \_',rendered)
        self.assertIn(r'\vert ',rendered)
        normal='<m:r><m:rPr><m:nor/></m:rPr><m:t>æøå #_%</m:t></m:r>'
        self.assertEqual(tex(normal),r'\text{æøå \#\_\%}')

    def test_word_layout_page_break_inside_math_run_keeps_the_formula(self):
        # Word persists pagination markers between its run properties and math
        # text. They carry no equation content and must not cause a fallback.
        word_run='<m:r><w:rPr><w:rFonts w:ascii="Cambria Math"/></w:rPr><w:lastRenderedPageBreak/><m:t>x</m:t></m:r>'
        self.assertEqual(tex(word_run), 'x')
        source=docx(display(word_run+mt('+1')))
        result=docx_import.convert_upload(source,'Pagination.docx')
        self.assertEqual(result['__stats__']['math_fallbacks'],0)
        self.assertNotIn('__warnings__',result)
        self.assertIn('$$\nx+1\n$$',result['Word import/Pagination.md'])

    def test_underlined_directional_arrows_from_economics_notes(self):
        self.assertEqual(tex(mt('↑\u0332')),r'\underline{\uparrow }')
        self.assertEqual(tex(mt('↓\u0332')),r'\underline{\downarrow }')
        self.assertEqual(tex(mt('↑\u0333')),r'\underline{\underline{\uparrow }}')

    def test_unsupported_equation_visible_and_both_sources_retained(self):
        unsupported='<m:phant>'+arg('e',mt('x + y `student source`'))+'</m:phant>'
        source=docx(display(unsupported))
        result=docx_import.convert_upload(source,'Complex.docx')
        note=result['Word import/Complex.md']
        self.assertIn('**Word equation needs review:**',note)
        self.assertIn('x + y `student source`',note)
        self.assertIn('Word import/attachments/Complex equation 1.xml',note)
        self.assertIn('Word import/attachments/Complex original.docx',note)
        self.assertEqual(result['Word import/attachments/Complex original.docx'],source)
        fragment=ET.fromstring(result['Word import/attachments/Complex equation 1.xml'])
        self.assertEqual(''.join(fragment.itertext()),'x + y `student source`')
        self.assertEqual(result['__stats__']['math_fallbacks'],1)
        self.assertIn('phant',' '.join(result['__warnings__']))

    def test_malformed_unknown_and_overcomplex_math_are_not_partial_success(self):
        cases=[ '<m:f>'+arg('num',mt('a'))+'</m:f>',
                '<m:f>'+arg('num',mt('a'))+arg('den',mt('b'))+'<m:newThing>'+mt('lost')+'</m:newThing></m:f>',
                '<m:m><m:mr>'+arg('e',mt('1'))+'</m:mr><m:mr>'+arg('e',mt('2'))+arg('e',mt('3'))+'</m:mr></m:m>',
                '<m:futurePr>'+mt('kept')+'</m:futurePr>',
                '', '<m:e>'*81+mt('deep')+'</m:e>'*81 ]
        for source in cases:
            with self.subTest(source=source[:60]):
                result=omml.convert(math(source))
                self.assertIsNone(result.latex)
                self.assertTrue(result.warnings)

    def test_strict_namespace_aliases_and_alternate_content(self):
        body=display(fraction('x','y'))
        files=docx_import._checked_zip(docx(body))
        files['word/document.xml']=files['word/document.xml'].replace(W.encode(),b'http://purl.oclc.org/ooxml/wordprocessingml/main').replace(M.encode(),b'http://purl.oclc.org/ooxml/officeDocument/math')
        result=docx_import.convert_upload(pack(files),'Strict.docx')
        self.assertIn(r'\frac{x}{y}',result['Word import/Strict.md'])
        alternate='<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="m">'+inline(fraction('a','b'))+'</mc:Choice><mc:Fallback><w:r><w:t>fallback text</w:t></w:r></mc:Fallback></mc:AlternateContent>'
        result=docx_import.convert_upload(docx('<w:p>'+alternate+'</w:p>'),'Choice.docx')
        self.assertIn(r'$\frac{a}{b}$',result['Word import/Choice.md'])
        self.assertNotIn('fallback text',result['Word import/Choice.md'])
        # Malformed empty wrapper must not recurse forever.
        empty='<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"/>'
        result=docx_import.convert_upload(docx(empty+p('Visible')), 'Empty.docx')
        self.assertIn('Visible',result['Word import/Empty.md'])


class WordFolderTests(unittest.TestCase):
    def test_six_course_folder_preserves_hierarchy_and_distinct_images(self):
        result=docx_import.convert_upload(pack(course_files()),'Student courses.zip','Word import 2')
        notes=[key for key in result if key.endswith('.md')]
        self.assertEqual(len(notes),6)
        self.assertTrue(all(key.startswith('Word import 2/School/') for key in notes))
        for subject,rgb in [('IEcon',(30,80,220)),('BEcon',(220,70,40))]:
            path=f'Word import 2/School/{subject}/attachments/Lecture image1.png'
            self.assertEqual(result[path],image(rgb))
            self.assertIn('![['+path+']]',result[f'Word import 2/School/{subject}/Lecture.md'])
        self.assertIn('Æ Ø Å / æ ø å',result['Word import 2/School/Danish/Analyse.md'])
        self.assertEqual(result['__stats__']['converted'],6)
        self.assertEqual(result['__stats__']['math_fallbacks'],1)
        self.assertEqual(result['__stats__']['tables'],1)

    def test_windows_folder_note_and_attachment_collisions(self):
        source=docx(p('Body')+picture(),(1,2,3))
        files={'Courses/A:B/Lesson.docx':source,'Courses/A?B/Lesson.docx':source,
               'Courses/Case/Lesson.docx':source,'Courses/case/Lesson.docx':source,
               'Courses/Lesson.docx':source,'Courses/lesson.DOCX':source,
               'Courses/Exam.docx':source,'Courses/Exam.md/Inside.docx':source}
        result=docx_import.convert_upload(pack(files),'courses.zip')
        notes=[key for key in result if key.endswith('.md') and isinstance(result[key],str)]
        self.assertEqual(len(notes),8)
        self.assertEqual(len({key.lower() for key in result if not key.startswith('__')}),len([key for key in result if not key.startswith('__')]))
        self.assertNotIn('Word import/Courses/Exam.md',notes)
        self.assertIn('Word import/Courses/Exam 2.md',notes)
        for key in notes:
            for target in re.findall(r'!\[\[([^]]+)\]\]',result[key]):
                self.assertEqual(result[target],image((1,2,3)))
        self.assertTrue(any('safe, distinct Windows name' in message for message in result['__warnings__']))

    def test_legacy_and_corrupt_docs_retained_with_honest_stats(self):
        legacy=b'not converted legacy bytes'
        broken=b'broken ZIP'
        result=docx_import.convert_upload(pack({'Course/Good.docx':docx(p('Good')), 'Course/Old.doc':legacy,
               'Course/Bad.docx':broken,'Course/Slide.pptx':b'slide','Course/~$temp.docx':b'lock'}),'folder.zip')
        self.assertEqual(result['__stats__']['documents'],2)
        self.assertEqual(result['__stats__']['converted'],1)
        self.assertEqual(result['__stats__']['failed'],1)
        self.assertEqual(result['__stats__']['unsupported'],2)
        self.assertEqual(result['__stats__']['skipped'],4)
        self.assertEqual(result['Word import/Course/attachments/Old original.doc'],legacy)
        self.assertEqual(result['Word import/Course/attachments/Bad original.docx'],broken)
        self.assertTrue(any('Slide.pptx' in message for message in result['__warnings__']))

    def test_no_valid_docx_or_legacy_doc_never_claims_conversion(self):
        for data,name in [(pack({'Old.doc':b'bytes'}),'folder.zip'),(pack({'Bad.docx':b'bad'}),'folder.zip'),(b'legacy','old.doc'),(pack({'Other.xml':'<x/>'}),'broken.docx')]:
            with self.subTest(name=name),self.assertRaises(ValueError):
                docx_import.convert_upload(data,name)

    def test_duplicate_entries_rejected_and_path_escapes_skipped(self):
        buffer=io.BytesIO()
        with warnings.catch_warnings(),zipfile.ZipFile(buffer,'w') as archive:
            warnings.simplefilter('ignore',UserWarning)
            archive.writestr('Course.docx',docx(p('First')))
            archive.writestr('Course.docx',docx(p('Second')))
        with self.assertRaisesRegex(ValueError,'duplicate ZIP entry'):
            docx_import.convert_upload(buffer.getvalue(),'duplicate.zip')
        result=docx_import.convert_upload(pack({'../Escape.docx':docx(p('Escape')),'/Absolute.docx':docx(p('Escape')),'Safe.docx':docx(p('Safe'))}),'safe.zip')
        self.assertEqual(result['__stats__']['converted'],1)
        self.assertEqual([key for key in result if key.endswith('.md')],['Word import/Safe.md'])

    def test_nested_zip_expansion_uses_a_shared_budget(self):
        package=docx(p('A'*2000))
        with zipfile.ZipFile(io.BytesIO(package)) as archive:
            expanded=sum(item.file_size for item in archive.infolist())
        outer=pack({'One.docx':package,'Two.docx':package})
        budget=2*len(package)+expanded+1
        with patch.object(docx_import,'MAX_ZIP_BYTES',budget),self.assertRaisesRegex(ValueError,'safe ZIP import limit'):
            docx_import.convert_upload(outer,'courses.zip')

    def test_unsafe_destination_is_rejected(self):
        for destination in ('../Escape','/Absolute','C:/Other','A//B','.'):
            with self.subTest(destination=destination),self.assertRaises(ValueError):
                docx_import.convert_upload(docx(p('Body')),'Safe.docx',destination)


if __name__=='__main__':
    unittest.main()
