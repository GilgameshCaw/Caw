"""Exercise only installer source selection against disposable local Git repositories."""
import os, pathlib, subprocess, tempfile, sys
# Do not inherit a caller's replacement namespace or replacement-disable flag.
os.environ.pop('GIT_REPLACE_REF_BASE',None)
os.environ.pop('GIT_NO_REPLACE_OBJECTS',None)
os.environ['GIT_CONFIG_NOSYSTEM']='1'
os.environ['GIT_CONFIG_GLOBAL']='/dev/null'
source=(pathlib.Path(__file__).resolve().parents[1]/'install.sh').read_text()
def git(*args): return subprocess.check_output(['git',*args],stderr=subprocess.DEVNULL,text=True).strip()
def run(script,env): return subprocess.run(['bash','-eu','-c',script],env={**os.environ,**env},capture_output=True,text=True,timeout=20)
selection=source.split('# BEGIN reviewed source selection\n')[1].split('# END reviewed source selection')[0]
if '--negative-control' in sys.argv:
 selection=selection.replace('if [[ "$actual" != "$CAW_EXPECT_COMMIT" ]]; then','if false; then')
if '--replacement-negative-control' in sys.argv:
 selection=selection.replace('git --no-replace-objects', 'git')
validation=source.split('CAW_EXPECT_COMMIT="${CAW_EXPECT_COMMIT:-}"')[1].split('# Ask up front')[0]
stubs='''sudo() { shift 3; "$@"; }; log() { :; }; err() { echo "$*" >&2; };\n'''
with tempfile.TemporaryDirectory(prefix='caw-pin-') as temp:
 p=pathlib.Path(temp);origin=p/'origin';origin.mkdir();git('init','-b','master',str(origin));git('-C',str(origin),'config','user.name','local fixture');git('-C',str(origin),'config','user.email','fixture@example.invalid')
 (origin/'version').write_text('one');git('-C',str(origin),'add','.');git('-C',str(origin),'commit','-m','one');a=git('-C',str(origin),'rev-parse','HEAD')
 def invoke(dest,pin,branch='master',extra=None):
  return run(stubs+validation+selection+'\nprintf accepted',{'CAW_DIR':str(dest),'CAW_REPO':str(origin),'CAW_USER':'fixture','CAW_BRANCH':branch,'CAW_EXPECT_COMMIT':pin,**(extra or {})})
 dest=p/'good';dest.mkdir();r=invoke(dest,a.upper());assert r.returncode==0,r.stderr;assert git('-C',str(dest),'rev-parse','HEAD')==a;assert (dest/'version').read_text()=='one'
 # Move upstream; reject both fresh and existing destinations with old selection.
 (origin/'version').write_text('two');git('-C',str(origin),'commit','-am','two');b=git('-C',str(origin),'rev-parse','HEAD')
 (dest/'version').write_text('local edit');r=invoke(dest,a);assert r.returncode!=0 and 'mismatch' in r.stderr;assert (dest/'version').read_text()=='local edit';assert git('-C',str(dest),'rev-parse','HEAD')==a
 fresh=p/'fresh';fresh.mkdir();r=invoke(fresh,a);assert r.returncode!=0 and not (fresh/'version').exists()
 r=invoke(dest,b);assert r.returncode==0,r.stderr;assert git('-C',str(dest),'rev-parse','HEAD')==b
 r=invoke(p/'invalid','master');assert r.returncode!=0 and not (p/'invalid').exists()
 missing=p/'missing';missing.mkdir();r=invoke(missing,b,'absent');assert r.returncode!=0 and 'accepted' not in r.stdout
 unpinned=p/'unpinned';unpinned.mkdir();r=invoke(unpinned,'');assert r.returncode==0,r.stderr;assert git('-C',str(unpinned),'rev-parse','HEAD')==b
 print('PASS: original 7 local source-selection scenarios',flush=True)
 # Review R-01: a commit identifier must not select a replacement commit's tree.
 # Start from A so the index does not already contain B's file object.
 def existing(name):
  target=p/name;git('clone',str(origin),str(target));git('-C',str(target),'reset','--hard',a);return target
 replaced=existing('commit-replaced')
 git('-C',str(replaced),'replace',b,a)
 r=invoke(replaced,b)
 print('commit replacement:',r.returncode,(replaced/'version').read_text(),flush=True)
 assert r.returncode==0,r.stderr
 assert git('-C',str(replaced),'rev-parse','HEAD')==b
 assert (replaced/'version').read_text()=='two','selected B but materialized replacement A'
 assert git('-C',str(replaced),'rev-parse','refs/replace/'+b)==a,'must not delete operator refs'
 # A replacement of a file object must also be ignored, not only commit mappings.
 blob=existing('blob-replaced');ba=git('-C',str(origin),'rev-parse',a+':version');bb=git('-C',str(origin),'rev-parse',b+':version')
 git('-C',str(blob),'replace',bb,ba)
 r=invoke(blob,b);assert r.returncode==0,r.stderr
 assert (blob/'version').read_text()=='two','file object replacement changed selected content'
 assert git('-C',str(blob),'rev-parse','refs/replace/'+bb)==ba
 # Git supports a non-default replacement namespace; command-level disabling covers it.
 custom=existing('custom-replaced');namespace='refs/caw-test-replacements/'
 git('-C',str(custom),'update-ref',namespace+b,a)
 r=invoke(custom,b,extra={'GIT_REPLACE_REF_BASE':namespace});assert r.returncode==0,r.stderr
 assert (custom/'version').read_text()=='two','custom replacement namespace changed selected content'
 assert git('-C',str(custom),'rev-parse',namespace+b)==a
 # The opt-in change must not silently change unpinned legacy replacement semantics.
 legacy=existing('legacy-replaced');git('-C',str(legacy),'replace',b,a)
 r=invoke(legacy,'');assert r.returncode==0,r.stderr
 assert (legacy/'version').read_text()=='one','unpinned legacy behavior changed'
 print('PASS: 11 local source-selection scenarios; no installer bootstrap or dependency build executed')
