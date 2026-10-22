"""Build a local combined test input; never changes either supplied source."""
import sys
from pathlib import Path
finalization, retry, output = map(Path, sys.argv[1:])
a = finalization.read_text(encoding="utf-8")
b = retry.read_text(encoding="utf-8")
assert "event NetworkFinalized(" in a
old = next(line for line in a.splitlines() if "event NetworkCreated(" in line)
new = next(line for line in b.splitlines() if "event NetworkCreated(" in line)
a = a.replace(old, new)
for name, end in [("handleNetworkCreated", "handleNetworkFeeUpdated"),
                  ("handleNetworkFeeUpdated", "handleFeeCeilingLowered"),
                  ("handleFeeCeilingLowered", "syncL1FeeEvents")]:
    start, stop = "async function " + name, "async function " + end
    a = a[:a.index(start)] + b[b.index(start):b.index(stop)] + a[a.index(stop):]
with output.open("x", encoding="utf-8", newline="\n") as stream:
    stream.write(a)
