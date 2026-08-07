#!/bin/bash
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Falta Node.js 20.9 o superior. Instálalo desde https://nodejs.org"
  open "https://nodejs.org" || true
  read -r -p "Pulsa Enter para cerrar..."
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "Falta Docker Desktop. Instálalo desde https://www.docker.com/products/docker-desktop/"
  open "https://www.docker.com/products/docker-desktop/" || true
  read -r -p "Pulsa Enter para cerrar..."
  exit 1
fi
[ -f .env ] || cp .env.example .env
docker compose up -d postgres redis minio
if [ ! -d node_modules ]; then npm install; fi
npm run db:generate
npm run db:migrate -- --name init
npm run db:seed
npm run dev:api & API_PID=$!
npm run dev:web & WEB_PID=$!
trap 'kill $API_PID $WEB_PID 2>/dev/null || true' EXIT
sleep 8
open "http://localhost:3000"
wait
