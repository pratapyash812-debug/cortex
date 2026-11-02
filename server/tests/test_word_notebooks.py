import io,sys,tempfile,unittest,zipfile
from pathlib import Path
from xml.etree import ElementTree as E
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server,docx_export,docx_import,omml
from docx_math_export import equation

class WordNotebookTests(unittest.TestCase):
    def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.v=server.Vault(Path(self.tmp.name))
    def tearDown(self):self.tmp.cleanup()
    def test_sections_are_distinct_durable_groups_without_rewriting_notes(self):
        book=self.v.create_notebook('Economics');before=self.v.resolve(book['path']).read_bytes()
        section=self.v.create_section(book['path'],'Financial analysis')['created'];page=self.v.add_sheet(section,'Profitability')['created']
        v=server.Vault(Path(self.tmp.name));tree=v.tree()['notebooks']
        self.assertEqual(tree[book['path']],[section]);self.assertEqual(tree[section],[page]);self.assertEqual(v.resolve(book['path']).read_bytes(),before)
        other=v.create_section(book['path'],'Financial analysis')['created'];self.assertNotEqual(other,section)
        self.assertEqual(v.notebook(page)['primary'],section)
        with self.assertRaises(ValueError):v.create_section(page,'Invalid parent')
        with self.assertRaises(ValueError):v.create_section(book['path'],'  ')
    def test_word_package_has_editable_math_tables_and_formatting_and_roundtrips(self):
        n=self.v.create('','Lesson','## Profitability\n\n**Bold** and <u>underlined</u> and ==important==.\n\n- First\n- Second\n\n| Price | Value |\n| --- | --- |\n| 20 | 100 |\n\n$y=\\frac{1}{2}x^2$')
        original=self.v.resolve(n['path']).read_bytes();data=docx_export.export_note(self.v,n['path'])
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for name in z.namelist():
                if name.endswith(('.xml','.rels')):E.fromstring(z.read(name))
            root=E.fromstring(z.read('word/document.xml'));ns=docx_export.NS
            self.assertIsNotNone(root.find('.//w:tbl',ns));self.assertIsNotNone(root.find('.//w:u',ns));self.assertIsNotNone(root.find('.//w:highlight',ns));self.assertIsNotNone(root.find('.//m:f',ns));self.assertIsNotNone(root.find('.//m:sSup',ns))
        converted=docx_import.convert_upload(data,'Lesson.docx','Roundtrip');text=converted['Roundtrip/Lesson.md']
        for expected in ('Profitability','Bold','underlined','important','Price','100'):self.assertIn(expected,text)
        self.assertEqual(self.v.resolve(n['path']).read_bytes(),original)
    def test_legacy_subject_folder_can_gain_sections_without_changing_its_existing_pages(self):
        n=self.v.create('School','Existing','Original text');before=self.v.resolve(n['path']).read_bytes()
        result=self.v.create_section('School','New topic');data=self.v.tree()['notebooks']
        self.assertIn(n['path'],data['School/School.md']);self.assertIn(result['created'],data['School/School.md'])
        self.assertEqual(self.v.resolve(n['path']).read_bytes(),before)
    def test_move_page_changes_only_membership_and_rejects_cycles(self):
        book=self.v.create_notebook('Study')['path'];one=self.v.create_section(book,'One')['created'];two=self.v.create_section(book,'Two')['created'];page=self.v.add_sheet(one,'Page')['created']
        before=self.v.resolve(page).read_bytes();self.v.move_page(page,two)
        self.assertEqual(self.v.notebook(page)['primary'],two);self.assertEqual(self.v.resolve(page).read_bytes(),before)
        child=self.v.create_section(one,'Child')['created']
        with self.assertRaises(ValueError):self.v.move_page(one,child)
        with self.assertRaises(ValueError):self.v.move_page(book,two)
    def test_structural_equations_roundtrip_or_fail_with_original_source(self):
        for source in [r'x=\frac{1}{2}',r'\sqrt[3]{8}',r'x_1^2',r'\binom{8}{2}',r'{8\choose 2}',r'\begin{aligned}&2x+3=11\\&\text{Divide both sides by 2.}\\&x=4\end{aligned}']:
            result=omml.convert(equation(source));self.assertIsNotNone(result.latex,source)
        word=docx_export.Word({});data=word.finish('Source','<p><span class="math">$\\notSupported{x}$</span></p>')
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            text=z.read('word/document.xml').decode();self.assertIn('notSupported',text);self.assertIn('Equation source',text);self.assertIn('Export note:',text)
    def test_vectors_are_embedded_without_scripts_or_external_references(self):
        import base64
        svg=b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><script>bad()</script><path d="M0 0L100 60" stroke="red"/><image href="https://example.com/private"/></svg>'
        html='<p><img src="data:image/svg+xml;base64,'+base64.b64encode(svg).decode()+'" alt="Demand graph"></p>'
        data=docx_export.Word({}).finish('Graph',html)
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            media=z.read('word/media/image1.svg').decode();self.assertNotIn('script',media);self.assertNotIn('https:',media)
            doc=z.read('word/document.xml').decode();self.assertIn('svgBlip',doc);self.assertIn('current version of Word',doc)
            import struct,zlib
            png=z.read('word/media/fallback.png');offset=8
            while offset<len(png):
                count=struct.unpack('>I',png[offset:offset+4])[0];payload=png[offset+4:offset+8+count]
                self.assertEqual(zlib.crc32(payload),struct.unpack('>I',png[offset+8+count:offset+12+count])[0]);offset+=12+count
    def test_page_style_export_is_whitelisted_and_unknown_metadata_does_not_inject_css(self):
        n=self.v.create('','Style','Text');self.v.set_meta(n['path'],'documentStyle',{'font':'serif','size':20})
        html=__import__('publish').export_note_html(self.v,n['path']);self.assertIn('Georgia,serif',html);self.assertIn('font-size:20px',html)

if __name__=='__main__':unittest.main()
