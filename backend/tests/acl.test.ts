/**
 * Item-level access control (rules X1–X7).
 *
 * The heart of this file is the rule X7 audit: it enumerates the Express router stack AT
 * RUNTIME and drives every GET route it finds against restricted items, asserting their
 * identifying strings never appear in any response. A hand-written list of routes to check
 * drifts the moment someone adds a route; reading the stack cannot.
 *
 * If enforcement is missing somewhere, this test MUST fail — do not weaken the assertion.
 */
import { describe, expect, it } from 'vitest';
import { BuildKind, BuildStatus, Lifecycle, Role } from '@prisma/client';
import request from 'supertest';
import app from '../src/index';
import { prisma } from '../src/lib/prisma';
import { Client, createAndLogin } from './helpers/api';

// ---------------------------------------------------------------------------
// Runtime route enumeration
// ---------------------------------------------------------------------------

interface DiscoveredRoute {
  method: string;
  path: string;
}

/** Best-effort decode of an Express mount regexp back into its path prefix. */
function mountPathOf(layer: { regexp?: RegExp }): string {
  const source = layer.regexp?.source ?? '';
  // "^\/api\/auth\/?(?=\/|$)" -> "/api/auth"; "^\/?(?=\/|$)" -> ""
  const match = source.match(/^\^((?:\\\/[^\\?$()]*)*)/);
  if (!match) return '';
  return match[1].replace(/\\\//g, '/').replace(/\/$/, '');
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function collectRoutes(stack: any[], prefix: string, out: DiscoveredRoute[]): void {
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        out.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      collectRoutes(layer.handle.stack, prefix + mountPathOf(layer), out);
    }
  }
}

/**
 * Turn one route pattern into the concrete URLs to probe.
 *
 * Express patterns are not simply `:name` — a param can carry an inline regex constraining
 * it to a literal set, as in `/:entityPath(ecns|revisions|documents)/:id/signatures`.
 * Substituting an id there produces a URL that matches nothing and 404s, which is how a
 * genuinely leaking route once passed this sweep. Enumerating the alternatives instead means
 * the constrained segment is addressed the only way it can be.
 */
function expandRoute(pattern: string, ids: number[]): string[] {
  const constrained = pattern.match(/:[A-Za-z0-9_]+\(([^)]+)\)/);
  if (constrained) {
    const alternatives = constrained[1].split('|');
    return alternatives.flatMap((alt) =>
      expandRoute(pattern.replace(constrained[0], alt), ids)
    );
  }
  // `/:entityType/:id/access` constrains its first segment in the handler rather than in the
  // pattern, so the regex above cannot see it. Substituting a number would 404 the same way.
  if (pattern.includes(':entityType')) {
    return ACL_SEGMENTS.flatMap((segment) =>
      expandRoute(pattern.replace(':entityType', segment), ids)
    );
  }
  if (!pattern.includes(':')) return [pattern];
  return ids.map((id) => pattern.replace(/:[A-Za-z0-9_]+/g, String(id)));
}

/** The five URL segments `access.ts` accepts for `/:entityType/:id/access`. */
const ACL_SEGMENTS = ['parts', 'documents', 'ecns', 'projects', 'build-units'];

/**
 * A route pattern whose parameter carries an inline regex is the shape that once defeated
 * this sweep entirely. Those must always be reachable; everything else may legitimately 404
 * because our probe ids belong to a different entity's id space.
 */
function hasInlineRegexParam(pattern: string): boolean {
  return /:[A-Za-z0-9_]+\([^)]+\)/.test(pattern) || pattern.includes(':entityType');
}

function discoverRoutes(): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  // Express 4 keeps the top-level stack on app._router.
  const stack = (app as any)._router?.stack ?? [];
  collectRoutes(stack, '', routes);
  return routes;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Fixtures: one restricted item of every protected type, cross-linked into the
// structures whose traversals are the classic leak channels.
// ---------------------------------------------------------------------------

/** Marker strings that must NEVER surface to a caller without a grant. */
const MARKERS = [
  'XSECRETPN991',
  'XSECRETPARTNAME991',
  'XSECRETDOCTITLE991',
  'XSECRETECNTITLE991',
  'XSECRETPROJ991',
  'XSECRETUNIT991',
] as const;

interface RestrictedWorld {
  insider: Client;
  outsider: Client;
  partId: number;
  revisionId: number;
  documentId: number;
  ecnId: number;
  ecnNumber: string;
  projectId: number;
  unitId: number;
  /** Visible items that REFERENCE the restricted ones — the redaction surfaces. */
  visiblePartId: number;
  visibleRevisionId: number;
  visibleUnitId: number;
  /** Every string that identifies a restricted item, generated numbers included. */
  markers: string[];
}

async function buildRestrictedWorld(): Promise<RestrictedWorld> {
  const insider = await createAndLogin({ role: Role.ENGINEER });
  const outsider = await createAndLogin({ role: Role.ENGINEER });
  const granterId = insider.id;

  // Restricted part with a RELEASED revision (so BOM/build fixtures can use it).
  const part = await prisma.part.create({
    data: {
      partNumber: 'XSECRETPN991',
      name: 'XSECRETPARTNAME991',
      createdById: insider.id,
      revisions: {
        create: { revision: 'A', lifecycle: Lifecycle.RELEASED, createdById: insider.id },
      },
    },
    include: { revisions: true },
  });
  const revisionId = part.revisions[0].id;

  const document = await prisma.document.create({
    data: {
      docNumber: 'DOC-XSECRET-991',
      title: 'XSECRETDOCTITLE991',
      category: 'DRAWING',
      createdById: insider.id,
    },
  });

  const ecn = await prisma.ecn.create({
    data: {
      ecnNumber: 'ECN-XSECRET-991',
      title: 'XSECRETECNTITLE991',
      createdById: insider.id,
      items: { create: { partId: part.id } },
    },
  });

  const project = await prisma.project.create({
    data: {
      code: 'XSECRETPROJ991',
      name: 'XSECRETPROJ991 program',
      ownerId: insider.id,
      createdById: insider.id,
    },
  });

  const unit = await prisma.buildUnit.create({
    data: {
      kind: BuildKind.SERIAL,
      identifier: 'XSECRETUNIT991',
      partId: part.id,
      partRevisionId: revisionId,
      quantity: 1,
      status: BuildStatus.COMPLETED,
      createdById: insider.id,
    },
  });

  // Restrict all five to the insider alone (rule X1 — the first grant closes the item).
  await prisma.partAcl.create({
    data: { partId: part.id, userId: insider.id, grantedById: granterId },
  });
  await prisma.documentAcl.create({
    data: { documentId: document.id, userId: insider.id, grantedById: granterId },
  });
  await prisma.ecnAcl.create({
    data: { ecnId: ecn.id, userId: insider.id, grantedById: granterId },
  });
  await prisma.projectAcl.create({
    data: { projectId: project.id, userId: insider.id, grantedById: granterId },
  });
  await prisma.buildUnitAcl.create({
    data: { buildUnitId: unit.id, userId: insider.id, grantedById: granterId },
  });

  // A VISIBLE assembly whose BOM consumes the restricted part, and a visible unit that
  // consumed the restricted unit: the tree, where-used, genealogy, recall, CSV, compare and
  // analytics walks all cross these edges.
  const visible = await prisma.part.create({
    data: {
      partNumber: 'VISIBLE-ASSY-1',
      name: 'Visible assembly',
      category: 'ASSEMBLY',
      createdById: insider.id,
      revisions: {
        create: { revision: 'A', lifecycle: Lifecycle.IN_WORK, createdById: insider.id },
      },
    },
    include: { revisions: true },
  });
  const visibleRevisionId = visible.revisions[0].id;
  await prisma.bomLine.create({
    data: {
      parentRevisionId: visibleRevisionId,
      childPartId: part.id,
      findNumber: 10,
      quantity: 2,
    },
  });
  const visibleUnit = await prisma.buildUnit.create({
    data: {
      kind: BuildKind.SERIAL,
      identifier: 'VISIBLE-UNIT-1',
      partId: visible.id,
      partRevisionId: visibleRevisionId,
      quantity: 1,
      status: BuildStatus.IN_PROGRESS,
      createdById: insider.id,
    },
  });
  await prisma.asBuiltLine.create({
    data: {
      parentId: visibleUnit.id,
      childId: unit.id,
      quantity: 1,
      recordedById: insider.id,
    },
  });

  return {
    insider,
    outsider,
    partId: part.id,
    revisionId,
    documentId: document.id,
    ecnId: ecn.id,
    ecnNumber: ecn.ecnNumber,
    projectId: project.id,
    unitId: unit.id,
    visiblePartId: visible.id,
    visibleRevisionId,
    visibleUnitId: visibleUnit.id,
    markers: [...MARKERS, ecn.ecnNumber, 'DOC-XSECRET-991'],
  };
}

function assertNoMarkers(
  markers: string[],
  route: string,
  status: number,
  bodyText: string
): void {
  for (const marker of markers) {
    expect(
      bodyText.includes(marker),
      `${route} answered ${status} and leaked "${marker}": ${bodyText.slice(0, 400)}`
    ).toBe(false);
  }
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

describe('rule X7 — no GET route leaks a restricted item', () => {
  it('drives every discovered GET route with restricted ids and finds no identifying string', async () => {
    const world = await buildRestrictedWorld();
    const routes = discoverRoutes().filter((route) => route.method === 'GET');

    // The enumeration itself is under test: if Express changes shape and this returns
    // nothing, the sweep would pass vacuously. This app mounts far more than 40 GET routes.
    expect(routes.length).toBeGreaterThan(40);

    // Every id a path parameter could plausibly address, probed one at a time. The item ids
    // are enough: any route that resolves one of them and echoes identity fails the sweep.
    const probeIds = [
      world.partId,
      world.revisionId,
      world.documentId,
      world.ecnId,
      world.projectId,
      world.unitId,
    ];

    // Reachability is measured with the INSIDER, never the outsider. A correctly enforced
    // route answers the outsider 404 — the very response that means "denied" — so counting
    // the outsider's non-404s as coverage would score enforcement as absence of coverage,
    // exactly backwards. If the insider gets a real answer, the URL addresses live data and
    // the outsider's reply on the same URL is a meaningful test.
    const reached = new Set<string>();

    for (const route of routes) {
      for (const path of expandRoute(route.path, probeIds)) {
        const res = await world.outsider.get(path);
        const bodyText = `${res.text ?? ''} ${JSON.stringify(res.body ?? null)}`;
        assertNoMarkers(world.markers, `GET ${path}`, res.status, bodyText);

        if (!reached.has(route.path)) {
          const insider = await world.insider.get(path);
          if (insider.status !== 404) reached.add(route.path);
        }
      }
    }

    // A route whose every probe 404s proves nothing. That is exactly how
    // `/:entityPath(ecns|revisions|documents)/:id/signatures` leaked past an earlier version
    // of this sweep: naive `:param` substitution turned it into `/api/123/123/signatures`,
    // which routes nowhere, so a genuinely leaking route passed vacuously.
    //
    // Two guards replace that blind spot. First, no route with a constrained segment may go
    // unreached — that is the bug class that bit us, and it is always addressable.
    const unreachable = routes.map((r) => r.path).filter((p) => !reached.has(p));
    expect(
      unreachable.filter(hasInlineRegexParam),
      'a GET route with a constrained path segment was never reached, so its access ' +
        'enforcement is UNVERIFIED — teach expandRoute() how to address it'
    ).toEqual([]);

    // Second, the sweep must stay substantial. Without this, a refactor that broke route
    // discovery or id substitution would leave every assertion passing over an empty probe.
    expect(reached.size).toBeGreaterThan(30);

    // Everything else is reported, never silently counted as covered: these 404 because our
    // probe ids address a different entity's id space (a part id is not a service-record id),
    // so their enforcement rests on the per-module tests instead.
    const idSpaceMismatch = unreachable.filter((p) => !hasInlineRegexParam(p));
    if (idSpaceMismatch.length > 0) {
      console.warn(
        `[acl sweep] ${reached.size} routes probed; ${idSpaceMismatch.length} not addressable ` +
          `with these probe ids:\n  ${idSpaceMismatch.join('\n  ')}`
      );
    }
  }, 180_000);

  it('keeps restricted items out of search, filtered lists and exports', async () => {
    const world = await buildRestrictedWorld();
    const probes = [
      '/api/search?q=XSECRET',
      '/api/parts?search=XSECRET',
      '/api/parts?pageSize=100',
      '/api/documents?search=XSECRET',
      '/api/ecns?pageSize=100',
      '/api/projects?pageSize=100',
      '/api/build-units?search=XSECRET',
      '/api/build-units?pageSize=100',
      `/api/build-units?partId=${world.partId}`,
      '/api/erp/items.csv',
      '/api/erp/items.json',
      `/api/revisions/${world.visibleRevisionId}/bom/export.csv`,
      `/api/revisions/${world.visibleRevisionId}/material-requirements/export.csv`,
    ];
    for (const path of probes) {
      const res = await world.outsider.get(path);
      const bodyText = `${res.text ?? ''} ${JSON.stringify(res.body ?? null)}`;
      assertNoMarkers(world.markers, `GET ${path}`, res.status, bodyText);
    }
  });

  it('is a real test: an insider DOES see the markers (positive control)', async () => {
    const world = await buildRestrictedWorld();
    const detail = await world.insider.get(`/api/parts/${world.partId}`);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).toContain('XSECRETPN991');

    const tree = await world.insider.get(`/api/revisions/${world.visibleRevisionId}/bom`);
    expect(tree.status).toBe(200);
    expect(JSON.stringify(tree.body)).toContain('XSECRETPN991');
  });
});

describe('rules X2/X3 — the shape of a denial', () => {
  it('answers 404 (never 403) for an unreadable item, indistinguishable from a missing one', async () => {
    const world = await buildRestrictedWorld();
    const missing = await world.outsider.get('/api/parts/999999');
    const hidden = await world.outsider.get(`/api/parts/${world.partId}`);
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
  });

  it('answers 403 only for a readable item without a WRITE grant', async () => {
    const world = await buildRestrictedWorld();
    // Outsider gets READ — the item becomes visible but not writable.
    await prisma.partAcl.create({
      data: { partId: world.partId, userId: world.outsider.id, grantedById: world.insider.id },
    });
    const read = await world.outsider.get(`/api/parts/${world.partId}`);
    expect(read.status).toBe(200);
    const write = await world.outsider.patch(`/api/parts/${world.partId}`, { name: 'nope' });
    expect(write.status).toBe(403);
    expect(write.body.error).toBe('You do not have write access to this part');
  });

  it('redacts, not omits, a hidden child on a visible BOM (rule X4)', async () => {
    const world = await buildRestrictedWorld();
    const res = await world.outsider.get(`/api/revisions/${world.visibleRevisionId}/bom`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].childPart.partNumber).toBe('Restricted');
    expect(res.body[0].quantity).toBe(2);
    expect(res.body[0].findNumber).toBe(10);
  });

  it('does not leak a restricted item through its signature manifest', async () => {
    // Regression: `/:entityPath(ecns|revisions|documents)/:id/signatures` had no access check
    // at all. It answered 200 with `label` resolved by an unfiltered lookup — handing out the
    // part number of an item the caller was 404'd from everywhere else — and `canSign: true`
    // invited them to sign it. The route's constrained path segment also defeated the sweep
    // above, so nothing caught it.
    const world = await buildRestrictedWorld();

    const viaRevision = await world.outsider.get(`/api/revisions/${world.revisionId}/signatures`);
    expect(viaRevision.status).toBe(404);
    expect(JSON.stringify(viaRevision.body)).not.toContain('XSECRETPN991');

    const viaEcn = await world.outsider.get(`/api/ecns/${world.ecnId}/signatures`);
    expect(viaEcn.status).toBe(404);
    expect(JSON.stringify(viaEcn.body)).not.toContain(world.ecnNumber);

    const viaDocument = await world.outsider.get(`/api/documents/${world.documentId}/signatures`);
    expect(viaDocument.status).toBe(404);
    expect(JSON.stringify(viaDocument.body)).not.toContain('DOC-XSECRET-991');

    // Signing is a write against something they cannot even see — refused identically.
    const forge = await world.outsider.post(`/api/ecns/${world.ecnId}/signatures`, {
      meaning: 'APPROVED',
      password: 'correct-horse-battery',
    });
    expect(forge.status).toBe(404);

    // The insider still gets a working manifest — the fix gates, it does not break.
    const insider = await world.insider.get(`/api/revisions/${world.revisionId}/signatures`);
    expect(insider.status).toBe(200);
    expect(insider.body.label).toContain('XSECRETPN991');
  });

  it('lets an ADMIN through everything (rule X2 invariant 2)', async () => {
    const world = await buildRestrictedWorld();
    const admin = await createAndLogin({ role: Role.ADMIN });
    const res = await admin.get(`/api/parts/${world.partId}`);
    expect(res.status).toBe(200);
    expect(res.body.partNumber).toBe('XSECRETPN991');
  });

  it('honours group grants and ignores inactive groups', async () => {
    const world = await buildRestrictedWorld();
    const group = await prisma.accessGroup.create({
      data: {
        name: 'Propulsion',
        createdById: world.insider.id,
        members: { create: { userId: world.outsider.id } },
      },
    });
    await prisma.partAcl.create({
      data: { partId: world.partId, groupId: group.id, grantedById: world.insider.id },
    });
    const viaGroup = await world.outsider.get(`/api/parts/${world.partId}`);
    expect(viaGroup.status).toBe(200);

    await prisma.accessGroup.update({ where: { id: group.id }, data: { active: false } });
    const afterDeactivate = await world.outsider.get(`/api/parts/${world.partId}`);
    expect(afterDeactivate.status).toBe(404);
  });
});
