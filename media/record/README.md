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

Any account on the instance works. The script only navigates, opens tabs and
scrolls — it never submits a form. A read-only account is therefore fine and
slightly preferable: `seed.ts` creates `viewer@turboplm.local`, alongside
`demo@turboplm.local` (engineer) and `admin@turboplm.local` (admin).

One caveat if you record as the viewer: item-level access is enforced per
account, so anything restricted to a group the viewer is not in — the seeded
`PAY-6001` among them — is invisible, and the access beat will be skipped. Record
as the engineer to capture that scene.

Every subject is discovered at runtime from the list page that leads to it, so
nothing has to exist for the recording to succeed — a caption whose content the
page cannot show is skipped, and the skipped titles are printed at the end. Four
optional variables pin a specific fixture when you have one; each falls back to
list discovery:

| Variable | Pins |
| --- | --- |
| `TOUR_TOP_PART` | part id whose eBOM has a level below its own children |
| `TOUR_CAD_DOC` | document id whose latest version is a STEP / IGES / BREP file |
| `TOUR_SIGNED_ECN` | ECN id carrying at least one executed signature |
| `TOUR_TRACE_UNIT` | build unit id — a lot — that ended up inside shipped units |
