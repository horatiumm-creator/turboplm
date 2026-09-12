import { Request, Router } from 'express';
import { PartCategory } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler, HttpError } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { escapeLike } from '../lib/plm';
import { AclUser, aclFilter } from '../lib/acl';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Response DTO shapes (mirror frontend/src/api/types.ts exactly)
// ---------------------------------------------------------------------------

interface SearchHitDto {
  id: number;
  label: string;
  sublabel: string | null;
  route: string;
}

interface SearchResultsDto {
  parts: SearchHitDto[];
  documents: SearchHitDto[];
  ecns: SearchHitDto[];
  ecrs: SearchHitDto[];
  manufacturers: SearchHitDto[];
  requirements: SearchHitDto[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Readable label per part category (search sublabels). */
const CATEGORY_LABELS: Record<PartCategory, string> = {
  ASSEMBLY: 'Assembly',
  MECHANICAL: 'Mechanical',
  ELECTRICAL: 'Electrical',
  PURCHASED: 'Purchased',
  RAW_MATERIAL: 'Raw material',
  SOFTWARE: 'Software',
};

const MAX_HITS_PER_GROUP = 5;

function aclUser(req: Request): AclUser {
  if (!req.user) throw new HttpError(401, 'Not authenticated');
  return { id: req.user.id, role: req.user.role };
}

// ---------------------------------------------------------------------------
// GET /search — global search across parts, documents, ECNs, ECRs and
// manufacturers (max 5 hits per group, insensitive contains)
//
// Rule X5: search is the leak everything else guards against. A restricted item
// that surfaces here is fully identified (number *and* name) to someone who was
// never allowed to know it exists, and it takes two keystrokes to find. Every
// group below is therefore either filtered or explicitly justified as carrying
// no protected type — there is no third case.
//
// The filter goes in the `where`, never after the query: `take` runs in the
// database, so post-filtering a page of 5 would silently return fewer hits than
// the caller is entitled to and would turn "no results" into a probe for
// restricted numbers.
// ---------------------------------------------------------------------------

router.get(
  '/search',
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    if (q.length < 2) {
      const empty: SearchResultsDto = {
        parts: [],
        documents: [],
        ecns: [],
        ecrs: [],
        manufacturers: [],
        requirements: [],
      };
      res.json(empty);
      return;
    }

    const contains = { contains: escapeLike(q), mode: 'insensitive' as const };
    const user = aclUser(req);

    const [parts, documents, ecns, ecrs, manufacturers, requirements] = await Promise.all([
      prisma.part.findMany({
        // The `OR` here is exactly the collision aclFilter's `AND` wrapper exists
        // for: spread by key, a bare top-level `OR` from the filter would
        // overwrite the search term (or be overwritten by it) depending on
        // nothing but spread order.
        where: { OR: [{ partNumber: contains }, { name: contains }], ...aclFilter('PART', user) },
        orderBy: { partNumber: 'asc' },
        take: MAX_HITS_PER_GROUP,
        select: { id: true, partNumber: true, name: true, category: true },
      }),
      prisma.document.findMany({
        where: { OR: [{ docNumber: contains }, { title: contains }], ...aclFilter('DOCUMENT', user) },
        orderBy: { id: 'desc' },
        take: MAX_HITS_PER_GROUP,
        select: { id: true, docNumber: true, title: true },
      }),
      prisma.ecn.findMany({
        where: { OR: [{ ecnNumber: contains }, { title: contains }], ...aclFilter('ECN', user) },
        orderBy: { id: 'desc' },
        take: MAX_HITS_PER_GROUP,
        select: { id: true, ecnNumber: true, title: true, status: true },
      }),
      // ECRs are not an ACL-bearing type and this hit carries only the ECR's own
      // number and title — no part or ECN is joined in, so there is nothing here
      // to filter. (The ECR *detail* route, which does expose its part, is not
      // this file's.)
      prisma.ecr.findMany({
        where: { OR: [{ ecrNumber: contains }, { title: contains }] },
        orderBy: { id: 'desc' },
        take: MAX_HITS_PER_GROUP,
        select: { id: true, ecrNumber: true, title: true },
      }),
      // Manufacturers and requirements are not ACL-bearing and neither hit joins a
      // protected type: the labels are the manufacturer's own name and the
      // requirement's own number/title/status.
      prisma.manufacturer.findMany({
        where: { name: contains },
        orderBy: { name: 'asc' },
        take: MAX_HITS_PER_GROUP,
        select: { id: true, name: true },
      }),
      prisma.requirement.findMany({
        where: { OR: [{ reqNumber: contains }, { title: contains }] },
        orderBy: { reqNumber: 'asc' },
        take: MAX_HITS_PER_GROUP,
        select: { id: true, reqNumber: true, title: true, status: true },
      }),
    ]);

    // "linked parts" = distinct parts, not AML rows (a part may carry several
    // MPNs from the same manufacturer). The count is over parts, so it is an
    // aggregate over a protected type and needs the filter: without it a
    // manufacturer's sublabel moves from "2 linked parts" to "3 linked parts" the
    // moment a restricted part is sourced from them, which is exactly the
    // existence signal the feature denies elsewhere.
    const distinctLinks =
      manufacturers.length > 0
        ? await prisma.manufacturerPart.findMany({
            where: {
              manufacturerId: { in: manufacturers.map((m) => m.id) },
              part: { ...aclFilter('PART', user) },
            },
            distinct: ['manufacturerId', 'partId'],
            select: { manufacturerId: true },
          })
        : [];
    const linkedParts = new Map<number, number>();
    for (const link of distinctLinks) {
      linkedParts.set(link.manufacturerId, (linkedParts.get(link.manufacturerId) ?? 0) + 1);
    }

    const payload: SearchResultsDto = {
      parts: parts.map((part) => ({
        id: part.id,
        label: `${part.partNumber} — ${part.name}`,
        sublabel: CATEGORY_LABELS[part.category],
        route: `/parts/${part.id}`,
      })),
      documents: documents.map((doc) => ({
        id: doc.id,
        label: `${doc.docNumber} — ${doc.title}`,
        sublabel: null,
        route: `/documents/${doc.id}`,
      })),
      ecns: ecns.map((ecn) => ({
        id: ecn.id,
        label: `${ecn.ecnNumber} — ${ecn.title}`,
        sublabel: ecn.status,
        route: `/ecns/${ecn.id}`,
      })),
      ecrs: ecrs.map((ecr) => ({
        id: ecr.id,
        label: `${ecr.ecrNumber} — ${ecr.title}`,
        sublabel: null,
        route: `/ecrs/${ecr.id}`,
      })),
      // Manufacturers have no detail page — point at the parts list.
      manufacturers: manufacturers.map((manufacturer) => ({
        id: manufacturer.id,
        label: manufacturer.name,
        sublabel: `${linkedParts.get(manufacturer.id) ?? 0} linked parts`,
        route: '/parts',
      })),
      requirements: requirements.map((requirement) => ({
        id: requirement.id,
        label: `${requirement.reqNumber} — ${requirement.title}`,
        sublabel: requirement.status,
        route: `/requirements/${requirement.id}`,
      })),
    };
    res.json(payload);
  })
);

export default router;
