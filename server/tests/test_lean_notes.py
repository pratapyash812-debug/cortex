"""Public-route and storage contracts for the lean notes product."""
import sys,json,tempfile,threading,unittest,urllib.request,urllib.error,hashlib
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server,legacy_snapshot

class LeanNotesTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.httpd=server.make_server(str(self.root),0);self.v=server.Handler.vault
        self.thread=threading.Thread(target=self.httpd.serve_forever,daemon=True);self.thread.start()
        self.url=f'http://127.0.0.1:{self.httpd.server_port}'
    def tearDown(self):
        self.httpd.shutdown();self.httpd.server_close();self.thread.join(2);self.tmp.cleanup()
    def call(self,method,path,body=None):
        req=urllib.request.Request(self.url+path,method=method,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req) as r:return r.status,json.load(r)
        except urllib.error.HTTPError as e:
            with e:return e.code,json.load(e)
    def test_retry_is_idempotent_but_different_external_text_is_protected(self):
        note=self.v.create('','Maths','Initial');base=note['revision']
        saved=self.v.save(note['path'],'Latest',None,base)
        self.assertEqual(self.v.save(note['path'],'Latest',None,base)['revision'],saved['revision'])
        self.v.save(note['path'],'External edit',None,saved['revision'])
        status,result=self.call('PUT','/api/note',{'path':note['path'],'content':'My draft','baseRevision':base})
        self.assertEqual(status,409);self.assertIn('recovery',result)
        self.assertEqual(self.v.info(self.v.resolve(note['path']),True)['content'],'External edit')
    def test_recovery_only_endpoint_never_overwrites_and_deduplicates(self):
        n=self.v.create('','Draft','Saved');before=self.v.resolve(n['path']).read_bytes()
        body={'path':n['path'],'content':'Unacknowledged x² / æøå','baseRevision':'stale'}
        status,a=self.call('POST','/api/recovery/draft',body);_,b=self.call('POST','/api/recovery/draft',body)
        self.assertEqual(status,200);self.assertEqual(a['id'],b['id'])
        self.assertEqual(self.v.resolve(n['path']).read_bytes(),before)
        self.assertEqual(self.call('GET','/api/recovery?id='+a['id'])[1]['content'],body['content'])
        for path in ('../escape.md','.cortex/hidden.md','C:/escape.md'):
            self.assertEqual(self.call('POST','/api/recovery/draft',{**body,'path':path})[0],400)
    def test_removed_routes_do_not_mutate_notes(self):
        self.v.create('','Keep','Original');before=(self.root/'Keep.md').read_bytes()
        for route in ('/api/graph','/api/base','/api/bookmarks','/api/study','/api/tasks'):
            self.assertEqual(self.call('GET',route)[0],404,route)
        for route in ('/api/form/submit','/api/publish','/api/transcribe','/api/clip','/api/automations/log'):
            self.assertEqual(self.call('POST',route,{})[0],404,route)
        self.assertFalse(hasattr(self.v,'automations'));self.assertEqual((self.root/'Keep.md').read_bytes(),before)
    def test_legacy_snapshots_keep_computed_values_and_original_bytes(self):
        self.v.create('Economics','Revenue','```cortex-query\nfolder:Economics\n```',{'price':20,'quantity':5})
        self.v._write_app_json('bases.json',{'folder:Economics':{'columns':[{'key':'revenue','type':'formula','expr':'price * quantity'}]}})
        before={p.relative_to(self.root):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        result=legacy_snapshot.read(self.v)
        self.assertEqual(result['notices'],[],result['notices'])
        self.assertIn('100',str(result['snapshots']));self.assertTrue((self.root/'.cortex/legacy').is_dir())
        for p,data in before.items():self.assertEqual((self.root/p).read_bytes(),data,str(p))
    def test_malformed_legacy_data_is_retained_and_reported(self):
        self.v._write_app_json('bases.json',{'bad-scope':{}})
        before=(self.root/'.cortex/bases.json').read_bytes();result=legacy_snapshot.read(self.v)
        self.assertTrue(result['notices']);self.assertEqual((self.root/'.cortex/bases.json').read_bytes(),before)
    def test_upgrade_preserves_old_workspace_state_once_before_navigation(self):
        state={'tabs':[{'id':'old','kind':'graph'}],'workspaces':{'Exam':{'tabs':[{'id':'a','kind':'note','path':'A.md'}]}}}
        self.v._write_app_json('state.json',state)
        marker=self.root/'.cortex/legacy-migration.json';marker.unlink()
        legacy_snapshot.ensure(self.v)
        self.assertTrue(marker.is_file())
        stored=[json.loads(p.read_text(encoding='utf-8')) for p in (self.root/'.cortex/legacy').glob('*.json')]
        self.assertTrue(any(item['name']=='Original settings — state.json' and 'Exam' in item['text'] for item in stored))
        with patch.object(self.v,'notes',side_effect=AssertionError('Repeated migration scan')):
            legacy_snapshot.ensure(self.v)
    def test_drawing_options_and_original_canvas_round_trip(self):
        c=self.v.create_canvas('','Graph');before=self.v.resolve(c['path']).read_bytes()
        stroke={'id':'line','color':'#e5484d','width':3,'points':[0,0,100,-100]}
        status,saved=self.call('PUT','/api/canvas/drawing',{'path':c['path'],'strokes':[stroke],'options':{'grid':False,'axes':True}})
        self.assertEqual(status,200);self.assertEqual(saved['options'],{'grid':False,'axes':True})
        self.assertEqual(self.v.canvas_drawing(c['path'])['options'],saved['options']);self.assertEqual(self.v.resolve(c['path']).read_bytes(),before)
    def test_removed_secondary_routes_are_unavailable_and_notes_still_save(self):
        for path in ('/api/ai/status','/api/practice','/api/reminders'):
            self.assertEqual(self.call('GET',path)[0],404,path)
        for path in ('/api/ai/write','/api/ai/ask','/api/ai/edit','/api/reminders/done'):
            self.assertEqual(self.call('POST',path,{})[0],404,path)
        self.assertFalse(hasattr(server.Handler,'ai'))
        self.assertFalse(hasattr(server.Handler,'study'))
        self.assertFalse(hasattr(server.Handler,'reminders'))
        n=self.v.create('','Lesson','Initial')
        saved=self.call('PUT','/api/note',{'path':n['path'],'content':'Typed without AI','baseRevision':n['revision']})
        self.assertEqual(saved[0],200)
        self.assertEqual(self.v.info(self.v.resolve(n['path']),True)['content'],'Typed without AI')

if __name__=='__main__':unittest.main()
