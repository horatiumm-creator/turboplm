# TurboPLM — notes for Claude

## Hosting / deployment changes (2026-10-12)

- **Marketing site** (`landing/`) is hosted on **Cloudflare Pages** (project
  `turboplm-landing`) and serves `turboplm.com`. Redeploy with `wrangler pages deploy`
  against that project (or the Pages pipeline) — it is no longer served from this repo's
  Docker stack.
- **The public demo was retired.** The single-tenant demo app (this repo's `docker-compose`
  web/api/db/cad) is **stopped**, and **`demo.turboplm.com` now 301-redirects to the SaaS**.
  Prospects start a **free trial by self-signing up on `saas.turboplm.com`** (no shared
  read-only demo anymore).
- **The multi-tenant SaaS** (separate repo `saas-turboplm`) now runs on **Cloudflare**
  (Worker + Container + Neon Postgres + R2), not local Docker.

## The landing no longer advertises the demo (done 2026-10-14)
`landing/` was reworked for the retirement. The nav item, hero button, the whole `#demo`
section, the tour note and the pricing lede are gone; the section is now `#start` ("Start
free"), and every CTA points at `https://saas.turboplm.com/register`. `404.html`, `README.md`,
`terms.html` (section 11 removed, 12-17 renumbered to 11-16, cross-references fixed) and
`privacy.html` (table row and "The public demo" section removed) were updated with it.

Still pointing at the retired host, and NOT yet fixed:
- `media/record/{shots.mjs,tour.mjs,README.md}` — the screenshot/tour recorders drove
  `demo.turboplm.com`. The default is now a local instance; re-recording against the SaaS
  needs an account and a seeded org (use the in-product "Load the sample product" button).
- `media/linkedin/30-day-posts.md` — drafts updated to point at the free tier.

## Self-hosting is unchanged
The open-source / self-hosted path still works as before: `git clone`,
`docker compose up -d --build`. Local file storage and the local DB are untouched.
