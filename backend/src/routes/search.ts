import { Router } from 'express';
import { PartCategory } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { escapeLike } from '../lib/plm';

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

// ---------------------------------------------------------------------------
// GET /search — global search across parts, documents, ECNs, ECRs and
// manufacturers (max 5 hits per group, insensitive contains)
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

    const [parts, documents, ecns, ecrs, manufacturers, requirements] = await Promise.all([
      prisma.part.findMany({
        where: { OR: [{ partNumber: contains }, { name: contains }] },
        orderBy: { partNumber: 'asc' },
        take: MAX_HITS_PER_GROUP,
        select: { id: true, partNumber: true, name: true, category: true },
      }),
      prisma.document.findMany({
        where: { OR: [{ docNumber: contains }, { title: contains }] },
        orderBy: { id: 'desc' },
        take: MAX_HITS_PER_GROUP,
        select: { id: true, docNumber: true, title: true },
      }),
      prisma.ecn.findMany({
        where: { OR: [{ ecnNumber: contains }, { title: contains }] },
        orderBy: { id: 'desc' },
        take: MAX_HITS_PER_GROUP,
        select: { id: true, ecnNumber: true, title: true, status: true },
      }),
      prisma.ecr.findMany({
        where: { OR: [{ ecrNumber: contains }, { title: contains }] },
        orderBy: { id: 'desc' },
        take: MAX_HITS_PER_GROUP,
        select: { id: true, ecrNumber: true, title: true },
      }),
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
    // MPNs from the same manufacturer).
    const distinctLinks =
      manufacturers.length > 0
        ? await prisma.manufacturerPart.findMany({
            where: { manufacturerId: { in: manufacturers.map((m) => m.id) } },
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
