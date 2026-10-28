"""Actual PDF text, identity changes, page coverage, subprocess cancellation."""
import os,sys,tempfile,threading,time,unittest,subprocess,json,sqlite3,importlib.metadata
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server,pdf_index,file_snapshot
try:
    import pypdf
    from pypdf.generic import DictionaryObject,NameObject,DecodedStreamObject
except ImportError:pypdf=None

def write_pdf(path,texts):
    path.parent.mkdir(parents=True,exist_ok=True);writer=pypdf.PdfWriter()
    for text in texts:
        page=writer.add_blank_page(width=300,height=300)
        if text is None:continue
        font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica'),NameObject('/Encoding'):NameObject('/WinAnsiEncoding')})
        page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
        contents=DecodedStreamObject();literal=text.encode('cp1252').replace(b'\\',b'\\\\').replace(b'(',b'\\(').replace(b')',b'\\)')
        contents.set_data(b'BT /F1 12 Tf 20 250 Td ('+literal+b') Tj ET');page[NameObject('/Contents')]=writer._add_object(contents)
    with path.open('wb') as stream:writer.write(stream)

@unittest.skipIf(pypdf is None,'Run with the trusted pinned pypdf package available')
class PdfTextTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.v=server.Vault(self.root/'vault');self.index=pdf_index.DocumentIndex(self.v,self.root/'cache')
    def tearDown(self):self.index.stop();self.temp.cleanup()

    def test_page_numbers_snippets_danish_and_persistence(self):
        p=self.v.root/'Sources/Economics.pdf';write_pdf(p,['Revenue and dækningsbidrag are terms.','Profit is revenue minus costs.'])
        before=p.read_bytes();self.index.index_once();result=self.index.search('profit')
        self.assertEqual(result['hits'][0]['page'],2);self.assertEqual(result['hits'][0]['path'],'Sources/Economics.pdf')
        self.assertIn('Profit',result['hits'][0]['snippet']);self.assertTrue(result['complete'])
        self.assertEqual(self.index.search('DÆKNINGSBIDRAG')['hits'][0]['page'],1)
        restarted=pdf_index.DocumentIndex(self.v,self.root/'cache')
        try:self.assertEqual(restarted.search('profit')['hits'],result['hits'])
        finally:restarted.stop()
        self.assertEqual(p.read_bytes(),before)

    def test_worker_resolves_its_siblings_when_the_runtime_omits_the_script_directory(self):
        source=self.root/'Isolated.pdf';write_pdf(source,['Revenue and dækningsbidrag'])
        script=str(Path(pdf_index.__file__).resolve())
        # -I/-S + run_path reproduce an embedded ._pth search path: stdlib is
        # available, but neither cwd nor the script's directory is importable.
        bootstrap='import runpy,sys;sys.argv='+repr([script,'--worker',str(source),'0',pdf_index.package_root()])+';runpy.run_path('+repr(script)+',run_name="__main__")'
        flags=getattr(subprocess,'CREATE_NO_WINDOW',0)
        result=subprocess.run([sys.executable,'-I','-S','-c',bootstrap],cwd=self.root,capture_output=True,timeout=10,creationflags=flags)
        self.assertEqual(result.returncode,0,result.stderr.decode(errors='replace'))
        events=[json.loads(line) for line in result.stdout.splitlines()]
        self.assertTrue(events[-1]['done']);self.assertIn('dækningsbidrag',events[1]['text'])

    def test_new_worker_engine_retries_the_previous_packaged_runtime_failure(self):
        source=self.v.root/'Book.pdf';write_pdf(source,['Revenue restored'])
        self.index._scan()
        db=sqlite3.connect(self.index.dbpath)
        try:
            db.execute("UPDATE index_meta SET value=? WHERE key='engine'",('pdf-text-v1:pypdf-'+importlib.metadata.version('pypdf'),))
            db.execute("UPDATE documents SET state='unsearchable',finished=1,reason='PDF worker ended before completing its text index.'")
            db.commit()
        finally:db.close()
        restarted=pdf_index.DocumentIndex(self.v,self.root/'cache')
        try:
            self.assertFalse(restarted.status()['indexingComplete'])
            restarted.index_once();self.assertTrue(restarted.status()['complete']);self.assertTrue(restarted.search('Revenue restored')['hits'])
        finally:restarted.stop()

    def test_same_size_and_restored_timestamp_do_not_return_stale_text(self):
        p=self.v.root/'Book.pdf';write_pdf(p,['Alpha12345']);self.index.index_once();self.assertTrue(self.index.search('Alpha12345')['hits']);old=p.stat()
        write_pdf(p,['Bravo12345']);self.assertEqual(p.stat().st_size,old.st_size);os.utime(p,ns=(old.st_atime_ns,old.st_mtime_ns))
        self.assertEqual(self.index.search('Alpha12345')['hits'],[])
        self.index.index_once();self.assertEqual(len(self.index.search('Bravo12345')['hits']),1)

    def test_blank_corrupt_and_mixed_pdfs_have_explicit_coverage(self):
        write_pdf(self.v.root/'Blank.pdf',[None,None]);write_pdf(self.v.root/'Mixed.pdf',['Revenue',None]);(self.v.root/'Broken.pdf').write_bytes(b'not a pdf')
        self.index.index_once();status=self.index.status();states={f['path']:f for f in status['files']}
        self.assertEqual(states['Blank.pdf']['state'],'unsearchable');self.assertIn('no OCR',states['Blank.pdf']['reason'])
        self.assertEqual(states['Mixed.pdf']['state'],'partial');self.assertEqual(states['Broken.pdf']['state'],'unsearchable')
        self.assertFalse(status['complete']);self.assertTrue(status['indexingComplete'])

    def test_foreground_edit_cancels_worker_and_partial_index_resumes(self):
        write_pdf(self.v.root/'Book.pdf',['Revenue first','Profit second']);failures=[]
        command=[sys.executable,'-u','-c',"import json,time;print(json.dumps({'pages':2}),flush=True);print(json.dumps({'page':1,'text':'Revenue first'}),flush=True);time.sleep(20)"]
        def run():
            try:self.index.index_once()
            except file_snapshot.WorkCancelled:failures.append('cancelled')
        with patch.object(self.index,'_command',return_value=command):
            thread=threading.Thread(target=run);thread.start();deadline=time.monotonic()+5
            while time.monotonic()<deadline:
                if self.index.status()['indexedPages']>=1:break
                time.sleep(.02)
            self.assertEqual(self.index.status()['indexedPages'],1);self.index.note_changed();thread.join(3)
        self.assertFalse(thread.is_alive());self.assertEqual(failures,['cancelled']);self.assertIsNone(self.index._process)
        self.index.index_once();self.assertEqual(self.index.search('Profit')['hits'][0]['page'],2)

    def test_input_changed_during_extraction_never_promotes_old_content(self):
        p=self.v.root/'Book.pdf';write_pdf(p,['Old revenue']);commit=self.index._commit_page
        def change(document,event):commit(document,event);write_pdf(p,['New profit'])
        with patch.object(self.index,'_commit_page',side_effect=change):
            with self.assertRaises(file_snapshot.InputChanged):self.index.index_once()
        self.assertEqual(self.index.search('Old revenue')['hits'],[])
        self.index.index_once();self.assertEqual(len(self.index.search('New profit')['hits']),1)

    def test_timeout_terminates_owned_process_and_preserves_other_documents(self):
        write_pdf(self.v.root/'Book.pdf',['Revenue'])
        self.index.worker_timeout=.2
        with patch.object(self.index,'_command',return_value=[sys.executable,'-c','import time;time.sleep(20)']):self.index.index_once()
        self.assertIsNone(self.index._process);status=self.index.status()
        self.assertIn('time limit',status['files'][0]['reason']);self.assertFalse(status['complete'])

    def test_memory_guard_kills_only_owned_worker_and_reports_coverage(self):
        write_pdf(self.v.root/'Book.pdf',['Revenue'])
        with patch.object(self.index,'_command',return_value=[sys.executable,'-c','import time;time.sleep(20)']),patch.object(pdf_index,'worker_memory',return_value=pdf_index.WORKER_MEMORY_BYTES+1):self.index.index_once()
        self.assertIsNone(self.index._process);self.assertIn('memory limit',self.index.status()['files'][0]['reason'])

    def test_encrypted_pdf_does_not_claim_its_text_was_read(self):
        path=self.v.root/'Private.pdf';writer=pypdf.PdfWriter();writer.add_blank_page(width=100,height=100);writer.encrypt('secret',use_128bit=False)
        with path.open('wb') as stream:writer.write(stream)
        self.index.index_once();status=self.index.status()
        self.assertEqual(status['files'][0]['state'],'unsearchable');self.assertIn('Encrypted',status['files'][0]['reason']);self.assertEqual(self.index.search('Revenue')['hits'],[])

    def test_scope_paths_deletion_and_unavailable_library(self):
        write_pdf(self.v.root/'A.pdf',['Revenue']);write_pdf(self.v.root/'B.pdf',['Revenue'])
        self.index.index_once();self.assertEqual(len(self.index.search('Revenue',path='A.pdf')['hits']),1)
        with self.assertRaises(ValueError):self.index.search('Revenue',path='../outside.pdf')
        (self.v.root/'A.pdf').unlink();self.assertEqual([h['path'] for h in self.index.search('Revenue')['hits']],['B.pdf'])
        with patch.object(pdf_index,'package_root',return_value=None):self.assertFalse(self.index.status()['available'])

if __name__=='__main__':unittest.main()
