#!/bin/bash
# Genera apps/landing/public/recursos/mapa-semana-consulta.pdf desde mapa.html con Chrome sin interfaz
# (macOS) y limpia los metadatos. Uso: bash apps/landing/recursos/mapa-semana-consulta/render.sh
set -euo pipefail
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
OUT="../../public/recursos/mapa-semana-consulta.pdf"
"$CHROME" --headless=new --disable-gpu --no-pdf-header-footer --allow-file-access-from-files \
  --print-to-pdf="$OUT" "file://$PWD/mapa.html" 2>/dev/null
node limpiar-pdf.mjs "$OUT"
python3 -c "import re,sys;d=open(sys.argv[1],'rb').read();n=len(re.findall(rb'/Type\s*/Page[^s]',d));print('paginas',n);sys.exit(0 if n==2 else 1)" "$OUT"
