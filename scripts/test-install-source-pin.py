"""Exercise only installer source selection against disposable local Git repositories."""
import os, pathlib, subprocess, tempfile, sys
os.environ['GIT_CONFIG_NOSYSTEM']='1'
os.environ['GIT_CONFIG_GLOBAL']='/dev/null'
source=(pathlib.Path(__file__).resolve().parents[1]/'install.sh').read_text()
def git(*args): return subprocess.check_output(['git',*args],stderr=subprocess.DEVNULL,text=True).strip()
def run(script,env): return subprocess.run(['bash','-eu','-c',script],env={**os.environ,**env},capture_output=True,text=True,timeout=20)
selection=source.split('# BEGIN reviewed source selection\n')[1].split('# END reviewed source selection')[0]
if '--negative-control' in sys.argv:
 selection=selection.replace('if [[ "$actual" != "$CAW_EXPECT_COMMIT" ]]; then','if false; then')
validation=source.split('CAW_EXPECT_COMMIT="${CAW_EXPECT_COMMIT:-}"')[1].split('# Ask up front')[0]
stubs='''sudo() { shift 3; "$@"; }; log() { :; }; err() { echo "$*" >&2; };\n'''
with tempfile.TemporaryDirectory(prefix='caw-pin-') as temp:
 p=pathlib.Path(temp);origin=p/'origin';origin.mkdir();git('init','-b','master',str(origin));git('-C',str(origin),'config','user.name','local fixture');git('-C',str(origin),'config','user.email','fixture@example.invalid')
 (origin/'version').write_text('one');git('-C',str(origin),'add','.');git('-C',str(origin),'commit','-m','one');a=git('-C',str(origin),'rev-parse','HEAD')
 def invoke(dest,pin,branch='master'):
  return run(stubs+validation+selection+'\nprintf accepted',{'CAW_DIR':str(dest),'CAW_REPO':str(origin),'CAW_USER':'fixture','CAW_BRANCH':branch,'CAW_EXPECT_COMMIT':pin})
 dest=p/'good';dest.mkdir();r=invoke(dest,a.upper());assert r.returncode==0,r.stderr;assert git('-C',str(dest),'rev-parse','HEAD')==a;assert (dest/'version').read_text()=='one'
 # Move upstream; reject both fresh and existing destinations with old selection.
 (origin/'version').write_text('two');git('-C',str(origin),'commit','-am','two');b=git('-C',str(origin),'rev-parse','HEAD')
 (dest/'version').write_text('local edit');r=invoke(dest,a);assert r.returncode!=0 and 'mismatch' in r.stderr;assert (dest/'version').read_text()=='local edit';assert git('-C',str(dest),'rev-parse','HEAD')==a
 fresh=p/'fresh';fresh.mkdir();r=invoke(fresh,a);assert r.returncode!=0 and not (fresh/'version').exists()
 r=invoke(dest,b);assert r.returncode==0,r.stderr;assert git('-C',str(dest),'rev-parse','HEAD')==b
 r=invoke(p/'invalid','master');assert r.returncode!=0 and not (p/'invalid').exists()
 missing=p/'missing';missing.mkdir();r=invoke(missing,b,'absent');assert r.returncode!=0 and 'accepted' not in r.stdout
 unpinned=p/'unpinned';unpinned.mkdir();r=invoke(unpinned,'');assert r.returncode==0,r.stderr;assert git('-C',str(unpinned),'rev-parse','HEAD')==b
 print('PASS: 7 local source-selection scenarios; no installer bootstrap or dependency build executed')
