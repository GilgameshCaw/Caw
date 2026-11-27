"""Replay the pinned PR #504 ownership round trip on Linux x86-64 using Python 3."""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import urllib.request

CANDIDATE = '4bbe9597c99b445b2aaa63b8f3c2da8615de269e'
STD = '77041d2ce690e692d6e03cc812b57d1ddaa4d505'
FORGE_HASH = 'a39fc1913b53dde6a35b603756f65d799e13817ef694107ec0d3704c20435cce'
SOLC_HASH = 'f3e987dc6ecebd4bd350c48edcbc320b46cf9e3109bd3fc3d88f1acaf4c428f7'
SOURCE_HASH = 'd39ffa4a5a21c4fb647b68d39f1f821d4b634fa1743da0578564e9db493d1718'
STD_HASH = '4066896156786a83f3c9d7108d1019b16717696e3e26b1f786f1fa4eb40577b9'
SUITE = 'test-foundry/RemoteOwnerRoundTrip.t.sol:RemoteOwnerRoundTripTest'
TEST = 'testCoalescedRoundTripInvalidatesBothKindsOfSessionOnce()'
CONFIG = {'remappings.txt', 'foundry.toml', 'package-lock.json'}


def download(url):
    with urllib.request.urlopen(url, timeout=90) as response:
        return response.read()


def require_hash(data, expected, label):
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f'SHA-256 mismatch: {label}')


def unpack(data, directory, prefix, include):
    # Copy matching regular files only. Drop the archive's top-level directory.
    written = []
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            if not member.isfile() or path.is_absolute() or '..' in path.parts:
                continue
            relative = '/'.join(path.parts[1:])
            if not relative.startswith(prefix):
                continue
            name = relative[len(prefix):]
            if not include(name):
                continue
            target = directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as output:
                shutil.copyfileobj(archive.extractfile(member), output)
            written.append(target)
    return written


def verify_tree(root, files, expected):
    lines = [f'{hashlib.sha256(f.read_bytes()).hexdigest()}  {f.relative_to(root)}\n' for f in sorted(files)]
    require_hash(''.join(lines).encode(), expected, root)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path, help='new directory for the replay and its results')
    parser.add_argument('--forge', default='forge', help='path to the Linux x86-64 Forge v1.5.1 binary')
    args = parser.parse_args()
    found = shutil.which(args.forge)
    if not found:
        parser.error('install Forge v1.5.1 or provide --forge /path/to/forge')
    forge = Path(found).resolve()
    require_hash(forge.read_bytes(), FORGE_HASH, forge)
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    source = download(f'https://codeload.github.com/Xubu-Trad/CawUsernames/tar.gz/{CANDIDATE}')
    files = unpack(source, root, 'solidity/', lambda f: f in CONFIG or
                   (f.startswith(('contracts/', 'test-foundry/')) and f.endswith('.sol')))
    verify_tree(root, files, SOURCE_HASH)
    lib = root / 'lib/forge-std'
    files = unpack(download(f'https://codeload.github.com/foundry-rs/forge-std/tar.gz/{STD}'), lib, '',
                   lambda f: f.startswith('src/') and f.endswith('.sol'))
    verify_tree(lib, files, STD_HASH)
    lock = json.loads((root / 'package-lock.json').read_text())['packages']
    for name in (root / 'remappings.txt').read_text().splitlines():
        target = name.split('=', 1)[1].rstrip('/')
        if not target.startswith('node_modules/'):
            continue
        pkg = lock[target]
        data = download(pkg['resolved'])
        expected = 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()
        if pkg['integrity'] != expected:
            raise ValueError(f'lockfile integrity mismatch: {target}')
        unpack(data, root / target, '', lambda f: f.endswith('.sol'))

    solc = root / 'solc-0.8.30'
    binary = download('https://raw.githubusercontent.com/ethereum/solc-bin/gh-pages/linux-amd64/solc-linux-amd64-v0.8.30+commit.73712a01')
    require_hash(binary, SOLC_HASH, solc)
    solc.write_bytes(binary)
    solc.chmod(0o755)
    cmd = [str(forge), 'test', '--root', str(root), '--use', str(solc), '--offline', '-j', '1',
           '--match-path', SUITE.split(':')[0], '--json']
    env = {k: v for k, v in os.environ.items() if not k.startswith(('FOUNDRY_', 'DAPP_'))}
    env.update(FOUNDRY_FFI='false', RAYON_NUM_THREADS='1')
    print('Running', subprocess.list2cmdline(cmd), flush=True)
    with (root / 'forge.json').open('w') as out, (root / 'forge.stderr').open('w') as err:
        result = subprocess.run(cmd, cwd=root, env=env, stdout=out, stderr=err)
    if result.returncode:
        raise SystemExit(f'Forge exited {result.returncode}. See {root}/forge.json and forge.stderr')
    suites = json.loads((root / 'forge.json').read_text())
    tests = suites[SUITE]['test_results']
    if set(suites) != {SUITE} or set(tests) != {TEST} or tests[TEST]['status'] != 'Success':
        raise ValueError('expected exactly one named passing test')
    print(f'PASS {CANDIDATE} {SUITE}::{TEST}')


if __name__ == '__main__':
    main()
