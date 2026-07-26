# Product tour recording

Records a screen-capture walkthrough of a running TurboPLM instance using
Playwright, writing `tour.webm` to `../out/`.

Credentials are **not** stored here. Supply an account on the target instance
through the environment:

```bash
docker run --rm --network edge \
  --add-host "demo.turboplm.com:$(docker inspect tsm-caddy \
     --format '{{.NetworkSettings.Networks.edge.IPAddress}}')" \
  -v "$PWD/record:/work:ro" -v "$PWD/out:/out" \
  -e TOUR_EMAIL="you@example.com" \
  -e TOUR_PASSWORD="…" \
  -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  mcr.microsoft.com/playwright:v1.49.0-jammy \
  bash -lc 'mkdir -p /app && cp /work/tour.mjs /app/ && cd /app \
    && npm init -y >/dev/null && npm i playwright@1.49.0 --no-audit --no-fund >/dev/null \
    && node tour.mjs'
```

Set `TOUR_BASE` to point at a different instance (defaults to
`https://demo.turboplm.com`).

A read-only account is sufficient and preferable: the script only navigates, but
a viewer account guarantees the recording cannot alter data.
