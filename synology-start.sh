#!/bin/bash
# KZIT su Synology: Pannello di controllo -> Utilità di pianificazione -> Script definito dall'utente, utente root.
# Costruisce e avvia i due contenitori (docker-compose.yml) e scrive l'esito in deploy.log nella stessa cartella.
DIR=/volume1/docker/kzit
export PATH=/usr/local/bin:/usr/bin:/bin:$PATH
cd "$DIR" || exit 1
{
  echo "=== $(date) ==="
  sed -i 's/\r$//' .env docker-compose.yml          # file modificati su Windows
  mkdir -p tailscale/state logs                     # il Docker di Synology non crea le cartelle dei volumi
  if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi
  echo "compose: $DC"
  $DC up -d --build
  sleep 30
  docker ps -a --filter name=kzit --format '{{.Names}}  {{.Status}}'
  echo "--- kzit-tailscale"; docker logs --tail 40 kzit-tailscale 2>&1
  echo "--- kzit"; docker logs --tail 10 kzit 2>&1
} > "$DIR/deploy.log" 2>&1
