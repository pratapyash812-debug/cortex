"""Public API contracts and per-vault service ownership."""
import json,sys,tempfile,threading,unittest,urllib.request,urllib.error
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server

class BackgroundRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.http=server.make_server(str(self.root/'vault'),0,backup_destination=self.root/'backups',document_cache=self.root/'search')
        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start();self.url=f'http://127.0.0.1:{self.http.server_port}'
    def tearDown(self):self.http.shutdown();self.http.server_close();self.thread.join(2);self.temp.cleanup()
    def call(self,method,path,body=None,ctype='application/json'):
        request=urllib.request.Request(self.url+path,method=method,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':ctype})
        try:
            with urllib.request.urlopen(request,timeout=5) as response:return response.status,json.load(response)
        except urllib.error.HTTPError as error:return error.code,json.load(error)

    def test_status_contracts_and_default_background_off(self):
        code,status=self.call('GET','/api/backups/status');self.assertEqual(code,200);self.assertTrue(status['localOnly']);self.assertFalse(status['running'])
        code,status=self.call('GET','/api/documents/status');self.assertEqual(code,200);self.assertTrue(status['noOCR']);self.assertEqual(status['totalFiles'],0)
        code,result=self.call('GET','/api/documents/search?q=profit');self.assertEqual(code,200);self.assertEqual(result['hits'],[])
        self.assertIsNone(self.http.RequestHandlerClass.documents._thread)
        self.assertIsNone(self.http.RequestHandlerClass.backups._thread)

    def test_backup_run_returns_before_worker_finishes_and_requires_json(self):
        service=self.http.RequestHandlerClass.backups;entered=threading.Event();release=threading.Event();threads=[]
        def slow_backup(*args,**kwargs):
            threads.append(threading.current_thread().name);entered.set();release.wait(3)
            with service._state:service._pending=False;service._manual=False
        with patch.object(service,'run_once',side_effect=slow_backup):
            try:
                code,status=self.call('POST','/api/backups/run',{});self.assertEqual(code,202);self.assertTrue(status['accepted'])
                self.assertTrue(entered.wait(1));self.assertFalse(release.is_set());self.assertEqual(threads,['Cortex local backups'])
            finally:release.set();service.stop()
        code,_=self.call('POST','/api/backups/run',{},ctype='application/x-www-form-urlencoded');self.assertEqual(code,400)

    def test_second_vault_cannot_replace_first_server_owner(self):
        other=server.make_server(str(self.root/'other'),0,backup_destination=self.root/'other-backups',document_cache=self.root/'other-search')
        try:
            first=self.http.RequestHandlerClass
            self.assertNotEqual(first.vault.root,other.RequestHandlerClass.vault.root)
            self.assertEqual(self.call('GET','/api/backups/status')[1]['destination'],str((self.root/'backups').resolve()))
            other.server_close();self.assertFalse(first.backups._stop.is_set())
        finally:other.server_close()

    def test_rejected_small_post_bodies_return_json_errors_without_running_backup(self):
        service=self.http.RequestHandlerClass.backups
        with patch.object(service,'request_run',side_effect=AssertionError('Rejected body must not start a backup')):
            for number in range(20):
                code,result=self.call('POST','/api/backups/run',{'ignored':'x'*(number*200)},ctype='application/x-www-form-urlencoded')
                self.assertEqual(code,400)
                self.assertIn('application/json',result['error'])
        self.assertFalse((self.root/'backups').exists())

    def test_pdf_search_rejects_foreign_paths_without_changing_notes(self):
        note=self.http.RequestHandlerClass.vault.create('','Keep','Saved')
        code,_=self.call('GET','/api/documents/search?q=x&path=../outside.pdf');self.assertEqual(code,400)
        self.assertEqual(self.http.RequestHandlerClass.vault.entry(self.root/'vault'/note['path']).body,'Saved')

if __name__=='__main__':unittest.main()
