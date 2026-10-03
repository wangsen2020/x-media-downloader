#!/usr/bin/env bash
# Render landscape (1280x800) + portrait (1125x1400) posters into tools/poster/out/.
#   python tools/poster/serve.py &          # repo-rooted no-cache server on :8766
#   bash tools/poster/render.sh <bsk-session> en zh_CN ar ...
set -e
S=$1; shift
cd "$(dirname "$0")"; mkdir -p out
for l in "$@"; do for lay in landscape portrait; do
  bsk navigate --session "$S" "http://localhost:8766/tools/poster/poster.html?lang=$l&layout=$lay" >/dev/null 2>&1
  r=""; for i in $(seq 1 12); do r=$(bsk evaluate --session "$S" "document.body.dataset.ready||''" 2>&1 | tail -1 | tr -d '"'); [ "$r" = "1" ] && break; sleep 1; done
  # Crop by #poster's rect: the RTL page lays the poster out at a horizontal offset.
  rect=$(bsk evaluate --session "$S" "(() => { scrollTo(0,0); const r = document.getElementById('poster').getBoundingClientRect(); return [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height), devicePixelRatio].join(','); })()" 2>&1 | tail -1 | tr -d '"')
  bsk screenshot --session "$S" --full-page --out out/raw.png >/dev/null 2>&1
  python -c "
from PIL import Image
x,y,w,h,d=[float(v) for v in '$rect'.split(',')]
im=Image.open('out/raw.png'); c=im.crop((round(x*d),round(y*d),round((x+w)*d),round((y+h)*d)))
if c.size!=(round(w),round(h)): c=c.resize((round(w),round(h)),Image.LANCZOS)
c.convert('RGB').save('out/${l}_${lay}.png'); print('$l $lay', c.size, 'ready=$r')"
done; done
rm -f out/raw.png
