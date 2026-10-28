"""Build a native arm64 Cortex.app and a verified DMG on an Apple Silicon Mac."""
from pathlib import Path
import argparse,hashlib,json,os,platform,plistlib,shutil,subprocess,sys,time,venv

ROOT=Path(__file__).resolve().parent

def run(args,**options):
    return subprocess.run([str(a) for a in args],check=True,**options)

def verify_inputs():
    manifest=json.loads((ROOT/'payload-manifest.json').read_text(encoding='utf-8'))
    for name,digest in manifest.items():
        path=(ROOT/name).resolve()
        if not path.is_relative_to(ROOT) or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=digest:
            raise ValueError('Build input failed verification: '+name)

def build(destination,developer_id=None,notary_profile=None):
    if sys.platform!='darwin' or platform.machine()!='arm64':raise RuntimeError('Run this builder on an Apple Silicon Mac with native arm64 Python.')
    if sys.version_info[:2]!=(3,13):raise RuntimeError('Use CPython 3.13 for this tested build recipe.')
    if bool(developer_id)!=bool(notary_profile):raise ValueError('Provide both Developer ID and an existing notarytool keychain profile, or neither for a local unnotarized build.')
    verify_inputs()
    for tool in ('hdiutil','codesign','lipo','ditto','xcrun'):
        if not shutil.which(tool):raise RuntimeError('Missing Mac build tool: '+tool)
    run(['xcrun','--find','clang'],stdout=subprocess.DEVNULL)
    destination=destination.resolve()
    if destination.exists():raise ValueError('Choose a new output directory; existing builds are never overwritten.')
    if destination==ROOT or ROOT.is_relative_to(destination):raise ValueError('Unsafe output directory')
    destination.mkdir(parents=True)
    environment=destination/'.venv';venv.EnvBuilder(with_pip=True).create(environment);python=environment/'bin/python'
    run([python,'-m','pip','--disable-pip-version-check','install','-r',ROOT/'requirements-macos.txt'])
    run([python,'-c',"from PIL import Image;from pathlib import Path;import sys;p=Path(sys.argv[1]);im=Image.open(p/'app/cortex.ico').convert('RGBA');im.save(p/'build-icon.icns',format='ICNS')",ROOT])
    env=os.environ.copy();env['MACOSX_DEPLOYMENT_TARGET']='13.0'
    if developer_id:env['CORTEX_CODESIGN_IDENTITY']=developer_id
    else:env.pop('CORTEX_CODESIGN_IDENTITY',None)
    run([python,'-m','PyInstaller','--noconfirm','--clean','--distpath',destination/'dist','--workpath',destination/'work',ROOT/'Cortex.spec'],cwd=ROOT,env=env)
    app=destination/'dist/Cortex.app';executable=app/'Contents/MacOS/Cortex'
    run(['lipo','-verify_arch','arm64',executable]);run(['codesign','--verify','--deep','--strict',app])
    backend=run([executable,'--cortex-self-test'],capture_output=True,text=True,timeout=120)
    (destination/'backend-smoke.json').write_text(backend.stdout,encoding='utf-8')
    if not json.loads(backend.stdout.strip().splitlines()[-1]).get('ok'):raise RuntimeError('Packaged backend smoke check failed')
    gui_result=destination/'gui-smoke.json'
    run([executable,'--cortex-gui-test',gui_result],timeout=90)
    if not json.loads(gui_result.read_text()).get('ok'):raise RuntimeError('Packaged Cocoa smoke check failed')
    if developer_id:
        # Upload is opt-in through explicit identity/profile arguments. The profile
        # already exists in the user's keychain; credentials are never written here.
        submission=destination/'Cortex-notarize.zip';run(['ditto','-c','-k','--keepParent',app,submission])
        run(['xcrun','notarytool','submit',submission,'--keychain-profile',notary_profile,'--wait'])
        run(['xcrun','stapler','staple',app]);run(['xcrun','stapler','validate',app]);run(['spctl','--assess','--type','execute','--verbose',app])
    staging=destination/'disk-image';staging.mkdir();run(['ditto',app,staging/'Cortex.app'])
    (staging/'Applications').symlink_to('/Applications',target_is_directory=True)
    (staging/'Install Cortex.txt').write_text('Drag Cortex.app to Applications, then eject this disk image and open Cortex.\nYour notes start in ~/Documents/Cortex. No Python, Node, AI model or account is needed.\n'+('Developer ID signed and notarized.\n' if developer_id else 'UNNOTARIZED local-test build. macOS may block downloaded unnotarized apps; no security settings have been changed.\n'),encoding='utf-8')
    version=json.loads((ROOT/'version.json').read_text())['version'];label='' if developer_id else '-UNNOTARIZED'
    dmg=destination/f'Cortex-{version}-macOS-arm64{label}.dmg'
    run(['hdiutil','create','-volname','Cortex','-srcfolder',staging,'-fs','HFS+','-format','UDZO',dmg]);run(['hdiutil','verify',dmg])
    if developer_id:
        run(['codesign','--timestamp','--sign',developer_id,dmg]);run(['xcrun','notarytool','submit',dmg,'--keychain-profile',notary_profile,'--wait']);run(['xcrun','stapler','staple',dmg]);run(['xcrun','stapler','validate',dmg])
    attachment=run(['hdiutil','attach','-readonly','-nobrowse','-plist',dmg],capture_output=True)
    entities=plistlib.loads(attachment.stdout)['system-entities'];mount=next(Path(e['mount-point']) for e in entities if 'mount-point' in e)
    try:run([mount/'Cortex.app/Contents/MacOS/Cortex','--cortex-self-test'],capture_output=True,timeout=120)
    finally:run(['hdiutil','detach',mount])
    packages=run([python,'-m','pip','freeze'],capture_output=True,text=True).stdout
    (destination/'resolved-build-requirements.txt').write_text(packages,encoding='utf-8')
    digest=hashlib.sha256(dmg.read_bytes()).hexdigest();(destination/(dmg.name+'.sha256')).write_text(f'{digest}  {dmg.name}\n',encoding='utf-8')
    receipt={'product':'Cortex','version':version,'architecture':'arm64','builtOn':platform.mac_ver()[0],'minimumMacOSDeclared':'13.0','notarized':bool(developer_id),'personalDataIncluded':False,'dmg':dmg.name,'bytes':dmg.stat().st_size,'sha256':digest,'checks':['arm64 executable','code-signature integrity','packaged backend and PDF worker','Cocoa WebKit UI','DMG integrity','read-only mounted app']}
    (destination/'build-receipt.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8');print(json.dumps(receipt,indent=2))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,default=ROOT/'output'/time.strftime('%Y%m%d-%H%M%S'));parser.add_argument('--developer-id');parser.add_argument('--notary-profile');args=parser.parse_args();build(args.output,args.developer_id,args.notary_profile)
