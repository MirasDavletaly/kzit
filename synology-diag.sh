#!/bin/bash
# KZIT su Synology: diagnostica (Utilità di pianificazione, utente root). Scrive diag.log nella cartella del progetto.
# Richiede il certificato HTTPS (tailscale cert) e mostra perché non arriva, lo stato di Funnel e dell'app.
DIR=/volume1/docker/kzit
NAME=kzit.tail81e59e.ts.net
export PATH=/usr/local/bin:/usr/bin:/bin:$PATH
{
  echo "=== $(date) ==="
  echo "--- Let's Encrypt dal NAS:"; curl -s -m 20 -o /dev/null -w "HTTP %{http_code} in %{time_total}s\n" https://acme-v02.api.letsencrypt.org/directory || echo "FAILED"
  echo "--- Let's Encrypt dal contenitore:"; docker exec kzit-tailscale wget -q -T 20 -O /dev/null https://acme-v02.api.letsencrypt.org/directory && echo "OK" || echo "FAILED"
  echo "--- certificato:"; docker exec kzit-tailscale tailscale cert --cert-file /tmp/c.crt --key-file /tmp/c.key "$NAME" 2>&1 | tail -5
  echo "--- funnel:"; docker exec kzit-tailscale tailscale funnel status 2>&1
  echo "--- app:"; docker exec kzit-tailscale wget -q -T 10 -O - http://127.0.0.1:3121/kzit/api/health 2>&1; echo
  echo "--- log tailscale:"; docker logs --tail 15 kzit-tailscale 2>&1
} > "$DIR/diag.log" 2>&1
