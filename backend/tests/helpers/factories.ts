/**
 * Direct-to-database fixtures.
 *
 * Arranging a scenario through the API would make every test depend on the rules it is
 * trying to isolate — a BOM cycle test cannot build its cycle through the endpoint that
 * rejects cycles. Setup therefore writes rows; the behaviour under test always goes
 * through HTTP.
 */
import { ConversionStatus, Lifecycle, PartCategory } from '@prisma/client';
import { prisma } from '../../src/lib/prisma';

let partSeq = 0;

export interface PartFixture {
  id: number;
  partNumber: string;
  name: string;
  /** Revision A, created with the part. */
  revisionId: number;
  revision: string;
}

export async function createPart(options: {
  createdById: number;
  partNumber?: string;
  name?: string;
  category?: PartCategory;
  uom?: string;
  unitCost?: number | null;
  lifecycle?: Lifecycle;
}): Promise<PartFixture> {
  partSeq += 1;
  const partNumber = options.partNumber ?? `T-${String(10000 + partSeq)}`;
  const name = options.name ?? `Test part ${partSeq}`;
  const lifecycle = options.lifecycle ?? Lifecycle.IN_WORK;
  const part = await prisma.part.create({
    data: {
      partNumber,
      name,
      category: options.category ?? PartCategory.MECHANICAL,
      uom: options.uom ?? 'ea',
      unitCost: options.unitCost ?? null,
      createdById: options.createdById,
      revisions: {
        create: {
          revision: 'A',
          lifecycle,
          createdById: options.createdById,
          releasedAt: lifecycle === Lifecycle.RELEASED ? new Date() : null,
        },
      },
    },
    include: { revisions: true },
  });
  return {
    id: part.id,
    partNumber: part.partNumber,
    name: part.name,
    revisionId: part.revisions[0].id,
    revision: part.revisions[0].revision,
  };
}

/** A part whose revision A is already RELEASED — the usual BOM child. */
export async function createReleasedPart(
  options: Parameters<typeof createPart>[0]
): Promise<PartFixture> {
  return createPart({ ...options, lifecycle: Lifecycle.RELEASED });
}

export async function addRevision(options: {
  partId: number;
  createdById: number;
  revision: string;
  lifecycle?: Lifecycle;
}): Promise<{ id: number; revision: string }> {
  const lifecycle = options.lifecycle ?? Lifecycle.IN_WORK;
  const rev = await prisma.partRevision.create({
    data: {
      partId: options.partId,
      revision: options.revision,
      lifecycle,
      createdById: options.createdById,
      releasedAt: lifecycle === Lifecycle.RELEASED ? new Date() : null,
    },
  });
  return { id: rev.id, revision: rev.revision };
}

export async function addBomLine(options: {
  parentRevisionId: number;
  childPartId: number;
  findNumber?: number;
  quantity?: number;
  uom?: string;
  refDesignators?: string | null;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
}): Promise<{ id: number; findNumber: number }> {
  const max = await prisma.bomLine.aggregate({
    where: { parentRevisionId: options.parentRevisionId },
    _max: { findNumber: true },
  });
  const line = await prisma.bomLine.create({
    data: {
      parentRevisionId: options.parentRevisionId,
      childPartId: options.childPartId,
      findNumber: options.findNumber ?? (max._max.findNumber ?? 0) + 10,
      quantity: options.quantity ?? 1,
      uom: options.uom ?? 'ea',
      refDesignators: options.refDesignators ?? null,
      effectiveFrom: options.effectiveFrom ?? null,
      effectiveTo: options.effectiveTo ?? null,
    },
  });
  return { id: line.id, findNumber: line.findNumber };
}

export async function setLifecycle(revisionId: number, lifecycle: Lifecycle): Promise<void> {
  await prisma.partRevision.update({
    where: { id: revisionId },
    data: {
      lifecycle,
      releasedAt: lifecycle === Lifecycle.RELEASED ? new Date() : null,
    },
  });
}

// ---------------------------------------------------------------------------
// Process plan / mBOM
// ---------------------------------------------------------------------------

export async function createProcessPlan(revisionId: number, name = 'Manufacturing Process') {
  return prisma.processPlan.create({ data: { partRevisionId: revisionId, name } });
}

export async function addOperation(options: { planId: number; seq: number; name?: string }) {
  return prisma.operation.create({
    data: { planId: options.planId, seq: options.seq, name: options.name ?? `Op ${options.seq}` },
  });
}

export async function addOperationMaterial(options: {
  operationId: number;
  partId: number;
  quantity: number;
  scrapFactor?: number;
  consumable?: boolean;
  uom?: string;
}) {
  return prisma.operationMaterial.create({
    data: {
      operationId: options.operationId,
      partId: options.partId,
      quantity: options.quantity,
      uom: options.uom ?? 'ea',
      scrapFactor: options.scrapFactor ?? 0,
      consumable: options.consumable ?? false,
    },
  });
}

// ---------------------------------------------------------------------------
// Documents and CAD snapshots
// ---------------------------------------------------------------------------

let docSeq = 0;

/**
 * A document with one version, optionally linked to a part or revision.
 *
 * The file is never written to disk: nothing in the cBOM path reads it, because the
 * kernel call is stubbed and the extracted structure is persisted as rows.
 */
export async function createDocumentVersion(options: {
  createdById: number;
  fileName?: string;
  partId?: number;
  partRevisionId?: number;
}): Promise<{ documentId: number; versionId: number; fileName: string }> {
  docSeq += 1;
  const fileName = options.fileName ?? `assembly-${docSeq}.step`;
  const doc = await prisma.document.create({
    data: {
      docNumber: `DOC-${20000 + docSeq}`,
      title: `Test document ${docSeq}`,
      createdById: options.createdById,
      versions: {
        create: {
          version: 1,
          fileName,
          mimeType: 'application/step',
          sizeBytes: 1024,
          storagePath: `test-${docSeq}-${fileName}`,
          uploadedById: options.createdById,
        },
      },
      ...(options.partId !== undefined || options.partRevisionId !== undefined
        ? {
            links: {
              create: {
                partId: options.partId ?? null,
                partRevisionId: options.partRevisionId ?? null,
              },
            },
          }
        : {}),
    },
    include: { versions: true },
  });
  return { documentId: doc.id, versionId: doc.versions[0].id, fileName };
}

export interface CadTree {
  name: string;
  instances?: number;
  children?: CadTree[];
}

/**
 * Persist a cBOM snapshot for a document version exactly as `extractCadStructure` would,
 * so `readAssembly` serves it without ever calling the sidecar.
 */
export async function seedCadStructure(
  documentVersionId: number,
  root: CadTree
): Promise<void> {
  await prisma.cadStructure.deleteMany({ where: { documentVersionId } });
  let nodeCount = 0;
  let maxDepth = 0;
  const structure = await prisma.cadStructure.create({
    data: {
      documentVersionId,
      status: ConversionStatus.DONE,
      rootName: root.name,
      nodeCount: 0,
      maxDepth: 0,
    },
  });

  let frontier: { node: CadTree; parentId: number | null }[] = [{ node: root, parentId: null }];
  for (let depth = 0; frontier.length > 0; depth++) {
    const next: { node: CadTree; parentId: number | null }[] = [];
    for (const [index, item] of frontier.entries()) {
      nodeCount += 1;
      maxDepth = Math.max(maxDepth, depth);
      const created = await prisma.cadNode.create({
        data: {
          structureId: structure.id,
          parentId: item.parentId,
          name: item.node.name,
          instances: item.node.instances ?? 1,
          depth,
          seq: index,
        },
        select: { id: true },
      });
      for (const child of item.node.children ?? []) next.push({ node: child, parentId: created.id });
    }
    frontier = next;
  }

  await prisma.cadStructure.update({
    where: { id: structure.id },
    data: { nodeCount, maxDepth },
  });
}
