"""Tests only disposable data, including the frozen executable's PDF subprocess."""
from pathlib import Path
import hashlib,json,tempfile,threading,time,urllib.request

def make_pdf(path):
    from pypdf import PdfWriter
    from pypdf.generic import DictionaryObject,NameObject,DecodedStreamObject
    writer=PdfWriter();page=writer.add_blank_page(width=300,height=300)
    font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
    page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
    contents=DecodedStreamObject();contents.set_data(b'BT /F1 12 Tf 20 250 Td (Revenue and liquidity) Tj ET');page[NameObject('/Contents')]=writer._add_object(contents)
    with path.open('wb') as output:writer.write(output)

def backend_smoke():
    import server,pdf_index,auto_backup
    with tempfile.TemporaryDirectory(prefix='cortex-mac-check-') as directory:
        root=Path(directory);vault=server.Vault(root/'notebook');book=vault.create_notebook('Economics');page=vault.add_sheet(book['path'],'Worked example')
        vault.save(page['created'],'# Revenue\n\n$y=2x+3$\n\n| Year | Sales |\n| --- | --- |\n| 2026 | 3000 |\n',None)
        saved=(vault.root/page['created']).read_text(encoding='utf-8')
        assert '$y=2x+3$' in saved and '| 2026 | 3000 |' in saved
        pdf=vault.root/'Course.pdf';make_pdf(pdf);original=hashlib.sha256(pdf.read_bytes()).hexdigest()
        index=pdf_index.DocumentIndex(vault,root/'search')
        try:
            index.index_once();hits=index.search('liquidity')['hits']
            assert index.status()['complete'] and hits and hits[0]['page']==1
        finally:index.stop()
        assert hashlib.sha256(pdf.read_bytes()).hexdigest()==original
        backup=auto_backup.BackupService(vault,root/'backups')
        try:assert backup.run_once(manual=True)
        finally:backup.stop()
        http=server.make_server(str(vault.root),0,background_services=False,backup_destination=root/'http-backups',document_cache=root/'http-search')
        thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
        try:
            base=f'http://127.0.0.1:{http.server_port}'
            with urllib.request.urlopen(base+'/') as response:assert b'id="root"' in response.read()
            with urllib.request.urlopen(base+'/api/tree') as response:assert len(json.load(response)['notes'])==2
        finally:http.shutdown();http.server_close();thread.join(3)
    return json.dumps({'ok':True,'checks':['notebook','equation/table persistence','PDF subprocess and search','original unchanged','verified backup','bundled web UI','local HTTP API']})

def gui_smoke(result_path):
    import server,webview
    failures=[];passed=threading.Event()
    with tempfile.TemporaryDirectory(prefix='cortex-cocoa-check-') as directory:
        root=Path(directory);http=server.make_server(str(root/'notebook'),0,background_services=False,backup_destination=root/'backups',document_cache=root/'search')
        threading.Thread(target=http.serve_forever,daemon=True).start()
        window=webview.create_window('Cortex build verification',f'http://127.0.0.1:{http.server_port}',width=900,height=650)
        def check():
            try:
                for _ in range(100):
                    if window.evaluate_js("Boolean(document.querySelector('.lean-app #new-note'))"):
                        passed.set();break
                    time.sleep(.2)
                if not passed.is_set():failures.append('Cocoa WebKit did not render the application')
            except Exception as error:failures.append(str(error))
            finally:window.destroy()
        window.events.loaded+=lambda:threading.Thread(target=check,daemon=True).start()
        try:webview.start(gui='cocoa')
        finally:http.shutdown();http.server_close()
    result_path.write_text(json.dumps({'ok':passed.is_set() and not failures,'renderer':'Cocoa/WebKit','errors':failures},indent=2),encoding='utf-8')
    if not passed.is_set() or failures:raise RuntimeError('Cocoa smoke check failed: '+str(failures))
