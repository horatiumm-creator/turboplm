/**
 * TurboPLM seed script — compiled to dist/seed.js and run before the server starts.
 *
 * Idempotent: exits early when any Part already exists. Creates the demo users and
 * the TurboDrone X1 quadcopter demo product: ~25 parts in a 4-level eBOM, the top
 * assembly with rev A RELEASED and rev B IN_WORK, mixed leaf lifecycles (consistent
 * with the release gate: every BOM child of a RELEASED parent has a RELEASED
 * revision), and process plans for the battery pack and the top assembly.
 *
 * Everything after seedX1Pro() is an ADDITIVE module: materials, item-level access,
 * the drawing vault, redlines, serialised build units and service history. Those run
 * on databases the parts seed skipped, so they never touch `seededParts` and resolve
 * every row by natural key. See the block comment above seedMaterialCatalog().
 */
import fs from 'fs';
import bcrypt from 'bcryptjs';
import {
  BuildKind,
  BuildStatus,
  Lifecycle,
  MarkupKind,
  MarkupStatus,
  MaterialClass,
  MaterialForm,
  PartCategory,
  Prisma,
  Role,
  ServiceKind,
  ServiceStatus,
  User,
} from '@prisma/client';
import { prisma } from './lib/prisma';
import { UPLOAD_DIR, absoluteStoragePath } from './middleware/upload';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function daysAgo(days: number): Date {
  return new Date(NOW - days * DAY_MS);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

async function ensureUser(email: string, name: string, password: string, role: Role): Promise<User> {
  return prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name,
      passwordHash: bcrypt.hashSync(password, 10),
      role,
    },
  });
}

// ---------------------------------------------------------------------------
// Data tables
// ---------------------------------------------------------------------------

interface PartSpec {
  pn: string;
  name: string;
  category: PartCategory;
  uom?: string;
  description?: string;
  /** createdAt = daysAgo(ageDays); newer parts have smaller values. */
  ageDays: number;
  /** Lifecycle of revision A (default RELEASED, releasedAt set). */
  lifecycle?: Lifecycle;
  /** Creator (default the demo engineer). */
  by?: 'demo' | 'admin';
}

const PART_SPECS: PartSpec[] = [
  // Assemblies
  {
    pn: 'DRN-1000',
    name: 'TurboDrone X1 Quadcopter',
    category: 'ASSEMBLY',
    description: 'Flagship 10-inch quadcopter platform, 4S Li-ion powered.',
    ageDays: 45,
    by: 'admin',
  },
  { pn: 'ASM-1100', name: 'Frame Assembly', category: 'ASSEMBLY', ageDays: 44, by: 'admin' },
  { pn: 'ASM-1110', name: 'Propulsion Assembly', category: 'ASSEMBLY', ageDays: 44, by: 'admin' },
  { pn: 'ASM-1111', name: 'Motor Pod Assembly', category: 'ASSEMBLY', ageDays: 43 },
  { pn: 'ASM-1120', name: 'Power Module Assembly', category: 'ASSEMBLY', ageDays: 43, by: 'admin' },
  {
    pn: 'ASM-1121',
    name: 'Battery Pack Assembly',
    category: 'ASSEMBLY',
    description: '4S2P Li-ion battery pack with integrated BMS.',
    ageDays: 42,
  },
  { pn: 'ASM-1130', name: 'Avionics Assembly', category: 'ASSEMBLY', ageDays: 42, by: 'admin' },
  // Mechanical leaves
  { pn: 'MEC-2001', name: 'Carbon Fiber Arm', category: 'MECHANICAL', ageDays: 40 },
  { pn: 'MEC-2002', name: 'Center Plate, Top', category: 'MECHANICAL', ageDays: 40 },
  { pn: 'MEC-2003', name: 'Center Plate, Bottom', category: 'MECHANICAL', ageDays: 39 },
  { pn: 'MEC-2004', name: 'Motor Mount, CNC Aluminum', category: 'MECHANICAL', ageDays: 38 },
  { pn: 'MEC-2005', name: 'Battery Enclosure', category: 'MECHANICAL', ageDays: 37 },
  { pn: 'MEC-2006', name: 'Avionics Mounting Tray', category: 'MECHANICAL', ageDays: 36 },
  // Electrical leaves
  { pn: 'ELE-3001', name: 'ESC 35A BLHeli-32', category: 'ELECTRICAL', ageDays: 34 },
  { pn: 'ELE-3002', name: 'Power Distribution Board', category: 'ELECTRICAL', ageDays: 33 },
  { pn: 'ELE-3003', name: 'Main Power Harness XT60', category: 'ELECTRICAL', ageDays: 32 },
  { pn: 'ELE-3004', name: 'BMS Protection Board 4S', category: 'ELECTRICAL', ageDays: 31 },
  { pn: 'ELE-3005', name: 'Flight Controller F7', category: 'ELECTRICAL', ageDays: 30 },
  { pn: 'ELE-3006', name: 'GPS Module M10', category: 'ELECTRICAL', ageDays: 29 },
  // Purchased leaves
  { pn: 'PUR-4001', name: 'M3x8 Socket Head Cap Screw', category: 'PURCHASED', ageDays: 28 },
  { pn: 'PUR-4002', name: 'Propeller 10x4.5 CW', category: 'PURCHASED', ageDays: 27 },
  { pn: 'PUR-4003', name: 'Propeller 10x4.5 CCW', category: 'PURCHASED', ageDays: 27 },
  { pn: 'PUR-4004', name: 'Brushless Motor 2216 900KV', category: 'PURCHASED', ageDays: 26 },
  { pn: 'PUR-4005', name: 'Li-ion Cell 18650 3500mAh', category: 'PURCHASED', ageDays: 25 },
  // Raw material leaves
  { pn: 'RAW-5001', name: 'Carbon Fiber Sheet 2.0mm', category: 'RAW_MATERIAL', uom: 'm2', ageDays: 24 },
  { pn: 'RAW-5002', name: 'Nickel Strip 8x0.15mm', category: 'RAW_MATERIAL', uom: 'm', ageDays: 23 },
  // New part introduced on top-assembly rev B; not used by any RELEASED parent,
  // so an IN_WORK-only revision is fine (business rule 2 stays satisfied).
  {
    pn: 'ELE-3007',
    name: 'LED Navigation Light Set',
    category: 'ELECTRICAL',
    ageDays: 6,
    lifecycle: 'IN_WORK',
  },
];

interface BomLineSpec {
  pn: string;
  qty: number;
  uom?: string;
  refDes?: string;
  notes?: string;
}

/** Top-assembly rev A eBOM — reused as the base for the rev B copy. */
const TOP_ASSEMBLY_BOM: BomLineSpec[] = [
  { pn: 'ASM-1100', qty: 1 },
  { pn: 'ASM-1110', qty: 1 },
  { pn: 'ASM-1120', qty: 1 },
  { pn: 'ASM-1130', qty: 1 },
];

const BOMS: { parent: string; lines: BomLineSpec[] }[] = [
  { parent: 'DRN-1000', lines: TOP_ASSEMBLY_BOM },
  {
    parent: 'ASM-1100',
    lines: [
      { pn: 'MEC-2001', qty: 4 },
      { pn: 'MEC-2002', qty: 1 },
      { pn: 'MEC-2003', qty: 1 },
      { pn: 'PUR-4001', qty: 16, notes: 'Torque to 1.2 Nm with threadlocker' },
      { pn: 'RAW-5001', qty: 0.15, uom: 'm2', notes: 'Protection shims cut from sheet' },
    ],
  },
  {
    parent: 'ASM-1110',
    lines: [
      { pn: 'ASM-1111', qty: 4 },
      { pn: 'PUR-4002', qty: 2 },
      { pn: 'PUR-4003', qty: 2 },
      { pn: 'ELE-3001', qty: 4, refDes: 'ESC1,ESC2,ESC3,ESC4' },
    ],
  },
  {
    parent: 'ASM-1111',
    lines: [
      { pn: 'PUR-4004', qty: 1 },
      { pn: 'MEC-2004', qty: 1 },
      { pn: 'PUR-4001', qty: 4 },
    ],
  },
  {
    parent: 'ASM-1120',
    lines: [
      { pn: 'ASM-1121', qty: 1 },
      { pn: 'ELE-3002', qty: 1, refDes: 'PDB1' },
      { pn: 'ELE-3003', qty: 1, refDes: 'W1' },
    ],
  },
  {
    parent: 'ASM-1121',
    lines: [
      { pn: 'PUR-4005', qty: 8, notes: '4S2P configuration' },
      { pn: 'ELE-3004', qty: 1, refDes: 'BMS1' },
      { pn: 'MEC-2005', qty: 1 },
      { pn: 'RAW-5002', qty: 0.6, uom: 'm' },
    ],
  },
  {
    parent: 'ASM-1130',
    lines: [
      { pn: 'ELE-3005', qty: 1, refDes: 'FC1' },
      { pn: 'ELE-3006', qty: 1, refDes: 'GPS1' },
      { pn: 'MEC-2006', qty: 1 },
      { pn: 'PUR-4001', qty: 8 },
    ],
  },
];

interface OperationSpec {
  name: string;
  workCenter: string;
  description?: string;
  setup: number;
  run: number;
  materials?: { pn: string; qty: number; uom?: string; notes?: string }[];
}

const BATTERY_PACK_OPS: OperationSpec[] = [
  {
    name: 'Grade and match cells',
    workCenter: 'Battery Lab',
    description: 'Measure internal resistance and capacity; group matched cells.',
    setup: 15,
    run: 20,
    materials: [{ pn: 'PUR-4005', qty: 8, notes: '4S2P configuration' }],
  },
  {
    name: 'Spot-weld cell groups',
    workCenter: 'Welding Cell 2',
    setup: 20,
    run: 30,
    materials: [{ pn: 'RAW-5002', qty: 0.6, uom: 'm' }],
  },
  {
    name: 'Install BMS and wiring',
    workCenter: 'Electronics Bench',
    setup: 10,
    run: 25,
    materials: [{ pn: 'ELE-3004', qty: 1 }],
  },
  {
    name: 'Enclose and heat-shrink',
    workCenter: 'Assembly Line 1',
    setup: 5,
    run: 15,
    materials: [{ pn: 'MEC-2005', qty: 1 }],
  },
  {
    name: 'End-of-line test',
    workCenter: 'Test Bay',
    description: 'Charge/discharge cycle and BMS cutoff verification.',
    setup: 10,
    run: 12,
  },
];

const TOP_ASSEMBLY_OPS: OperationSpec[] = [
  {
    name: 'Frame integration',
    workCenter: 'Assembly Line 1',
    setup: 10,
    run: 30,
    materials: [{ pn: 'ASM-1100', qty: 1 }],
  },
  {
    name: 'Mount propulsion pods',
    workCenter: 'Assembly Line 1',
    setup: 5,
    run: 40,
    materials: [{ pn: 'ASM-1110', qty: 1 }],
  },
  {
    name: 'Install power module',
    workCenter: 'Assembly Line 2',
    setup: 5,
    run: 20,
    materials: [{ pn: 'ASM-1120', qty: 1 }],
  },
  {
    name: 'Avionics installation',
    workCenter: 'Electronics Bench',
    setup: 10,
    run: 35,
    materials: [{ pn: 'ASM-1130', qty: 1 }],
  },
  {
    name: 'Sensor calibration',
    workCenter: 'Test Bay',
    description: 'IMU, compass and GPS calibration.',
    setup: 15,
    run: 25,
  },
  { name: 'Flight test and QA', workCenter: 'Flight Test Range', setup: 20, run: 30 },
];

// ---------------------------------------------------------------------------
// Creation helpers
// ---------------------------------------------------------------------------

interface SeededPart {
  id: number;
  revAId: number;
}

const seededParts = new Map<string, SeededPart>();

function partOf(pn: string): SeededPart {
  const found = seededParts.get(pn);
  if (!found) throw new Error(`Seed: unknown part number ${pn}`);
  return found;
}

async function createPart(spec: PartSpec, users: { demo: User; admin: User }): Promise<void> {
  const creator = spec.by === 'admin' ? users.admin : users.demo;
  const lifecycle: Lifecycle = spec.lifecycle ?? 'RELEASED';
  const createdAt = daysAgo(spec.ageDays);
  const part = await prisma.part.create({
    data: {
      partNumber: spec.pn,
      name: spec.name,
      description: spec.description ?? null,
      category: spec.category,
      uom: spec.uom ?? 'ea',
      createdById: creator.id,
      createdAt,
      revisions: {
        create: {
          revision: 'A',
          lifecycle,
          createdById: creator.id,
          createdAt,
          releasedAt: lifecycle === 'RELEASED' ? daysAgo(Math.max(spec.ageDays - 2, 0)) : null,
        },
      },
    },
    include: { revisions: true },
  });
  seededParts.set(spec.pn, { id: part.id, revAId: part.revisions[0].id });
}

async function addBom(parentRevisionId: number, lines: BomLineSpec[]): Promise<void> {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    await prisma.bomLine.create({
      data: {
        parentRevisionId,
        childPartId: partOf(line.pn).id,
        findNumber: (i + 1) * 10,
        quantity: line.qty,
        uom: line.uom ?? 'ea',
        refDesignators: line.refDes ?? null,
        notes: line.notes ?? null,
      },
    });
  }
}

async function createInWorkRevisionB(opts: {
  pn: string;
  changeNote: string;
  createdBy: User;
  ageDays: number;
  bom?: BomLineSpec[];
}): Promise<void> {
  const revision = await prisma.partRevision.create({
    data: {
      partId: partOf(opts.pn).id,
      revision: 'B',
      lifecycle: 'IN_WORK',
      changeNote: opts.changeNote,
      createdById: opts.createdBy.id,
      createdAt: daysAgo(opts.ageDays),
    },
  });
  if (opts.bom) await addBom(revision.id, opts.bom);
}

async function addProcessPlan(
  partRevisionId: number,
  name: string,
  description: string,
  ops: OperationSpec[]
): Promise<void> {
  const plan = await prisma.processPlan.create({
    data: { partRevisionId, name, description },
  });
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const operation = await prisma.operation.create({
      data: {
        planId: plan.id,
        seq: (i + 1) * 10,
        name: op.name,
        workCenter: op.workCenter,
        description: op.description ?? null,
        setupMinutes: op.setup,
        runMinutes: op.run,
      },
    });
    for (const material of op.materials ?? []) {
      await prisma.operationMaterial.create({
        data: {
          operationId: operation.id,
          partId: partOf(material.pn).id,
          quantity: material.qty,
          uom: material.uom ?? 'ea',
          notes: material.notes ?? null,
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function seed(): Promise<void> {
  if ((await prisma.part.count()) > 0) {
    console.log('Seed: data already present, skipping');
    return;
  }

  const demo = await ensureUser('demo@turboplm.local', 'Demo Engineer', 'demo1234', 'ENGINEER');
  const admin = await ensureUser('admin@turboplm.local', 'Ada Admin', 'admin1234', 'ADMIN');
  // The README has always advertised this login; without it the read-only role could not be
  // demonstrated, and the access demo had no account OUTSIDE the cleared group to show a
  // restricted item disappearing for. Deliberately not a member of that group.
  await ensureUser('viewer@turboplm.local', 'Val Viewer', 'viewer1234', 'VIEWER');
  const users = { demo, admin };

  for (const spec of PART_SPECS) {
    await createPart(spec, users);
  }

  for (const bom of BOMS) {
    await addBom(partOf(bom.parent).revAId, bom.lines);
  }

  // Top assembly rev B: IN_WORK copy of the rev A eBOM plus the new LED light set.
  await createInWorkRevisionB({
    pn: 'DRN-1000',
    changeNote: 'Add LED navigation lights; switch to weight-reduced arms.',
    createdBy: demo,
    ageDays: 5,
    bom: [
      ...TOP_ASSEMBLY_BOM,
      { pn: 'ELE-3007', qty: 1, refDes: 'LED1,LED2,LED3,LED4', notes: 'New in rev B' },
    ],
  });

  // Carbon fiber arm rev B: a leaf part with an IN_WORK revision (mixed states).
  await createInWorkRevisionB({
    pn: 'MEC-2001',
    changeNote: 'Weight reduction cutouts; 12 g lighter per arm.',
    createdBy: demo,
    ageDays: 4,
  });

  await addProcessPlan(
    partOf('ASM-1121').revAId,
    'Battery Pack Assembly Process',
    'Cell matching, welding, BMS integration and final test of the 4S2P pack.',
    BATTERY_PACK_OPS
  );
  await addProcessPlan(
    partOf('DRN-1000').revAId,
    'TurboDrone X1 Final Assembly',
    'Final assembly, calibration and flight test of the TurboDrone X1.',
    TOP_ASSEMBLY_OPS
  );

  const bomLineCount = BOMS.reduce((sum, b) => sum + b.lines.length, 0) + TOP_ASSEMBLY_BOM.length + 1;
  console.log(
    `Seed: created 2 users, ${PART_SPECS.length} parts, ${bomLineCount} BOM lines and 2 process plans`
  );
}

/**
 * ECN demo seed — runs independently of the parts seed so existing databases
 * (parts already present) still get the demo change notice.
 */
async function seedEcn(): Promise<void> {
  if ((await prisma.ecn.count()) > 0) {
    console.log('Seed: ECNs already present, skipping');
    return;
  }

  const demo = await prisma.user.findUnique({ where: { email: 'demo@turboplm.local' } });
  const drone = await prisma.part.findUnique({
    where: { partNumber: 'DRN-1000' },
    include: { revisions: { orderBy: { id: 'asc' } } },
  });
  if (!demo || !drone) return;

  const droneRevA = drone.revisions.find((r) => r.revision === 'A');
  const droneRevB = drone.revisions.find((r) => r.revision === 'B');
  if (!droneRevB || droneRevB.lifecycle !== 'IN_WORK') return;
  const droneRevBLinked = await prisma.ecnItem.findFirst({
    where: { toRevisionId: droneRevB.id },
  });
  if (droneRevBLinked) return;

  const ecn = await prisma.ecn.create({
    data: {
      ecnNumber: 'ECN-10001',
      title: 'LED navigation lights & weight-reduced arms',
      reason:
        'Customer request: night-flight visibility per EASA guidance; arm weight-reduction program (-48 g per aircraft).',
      description:
        'Introduce the LED navigation light set on the top assembly and switch to weight-reduced carbon fiber arms. Existing arm stock is reworked; assemblies in the field are unaffected.',
      priority: 'MEDIUM',
      status: 'DRAFT',
      createdById: demo.id,
      createdAt: daysAgo(4),
      items: {
        create: [
          {
            partId: drone.id,
            fromRevisionId: droneRevA?.id ?? null,
            toRevisionId: droneRevB.id,
            changeDescription:
              'Add LED navigation light set (ELE-3007) to the eBOM; update final assembly instructions.',
            disposition: 'USE_AS_IS',
          },
        ],
      },
    },
  });

  const arm = await prisma.part.findUnique({
    where: { partNumber: 'MEC-2001' },
    include: { revisions: { orderBy: { id: 'asc' } } },
  });
  const armRevA = arm?.revisions.find((r) => r.revision === 'A');
  const armRevB = arm?.revisions.find((r) => r.revision === 'B');
  if (arm && armRevB && armRevB.lifecycle === 'IN_WORK') {
    const armLinked = await prisma.ecnItem.findFirst({ where: { toRevisionId: armRevB.id } });
    if (!armLinked) {
      await prisma.ecnItem.create({
        data: {
          ecnId: ecn.id,
          partId: arm.id,
          fromRevisionId: armRevA?.id ?? null,
          toRevisionId: armRevB.id,
          changeDescription: 'Weight-reduction cutouts; 12 g lighter per arm.',
          disposition: 'REWORK',
        },
      });
    }
  }

  console.log(`Seed: created demo ECN ${ecn.ecnNumber}`);
}

/**
 * TurboDrone X1 Pro — a second 4-level product for BOM-compare demos. Shares the
 * frame/propulsion/avionics subassemblies with the X1 but swaps the power module
 * for a 6S variant and adds a camera gimbal branch. Runs independently of the
 * other seed steps so existing databases pick it up.
 */
async function seedX1Pro(): Promise<void> {
  if (await prisma.part.findUnique({ where: { partNumber: 'DRN-2000' } })) {
    console.log('Seed: X1 Pro already present, skipping');
    return;
  }
  const demo = await prisma.user.findUnique({ where: { email: 'demo@turboplm.local' } });
  const shared = await prisma.part.findMany({
    where: {
      partNumber: {
        in: ['ASM-1100', 'ASM-1110', 'ASM-1130', 'ELE-3002', 'ELE-3003', 'MEC-2005', 'RAW-5002'],
      },
    },
    select: { id: true, partNumber: true },
  });
  if (!demo || shared.length < 7) return;
  const sharedId = new Map(shared.map((p) => [p.partNumber, p.id]));

  interface ProPartSpec {
    pn: string;
    name: string;
    category: PartCategory;
    description?: string;
    ageDays: number;
  }
  const PRO_PARTS: ProPartSpec[] = [
    {
      pn: 'DRN-2000',
      name: 'TurboDrone X1 Pro Quadcopter',
      category: 'ASSEMBLY',
      description: '6S long-range variant with 4K camera gimbal.',
      ageDays: 20,
    },
    { pn: 'ASM-1122', name: 'Power Module Assembly 6S', category: 'ASSEMBLY', ageDays: 19 },
    {
      pn: 'ASM-1123',
      name: 'Battery Pack Assembly 6S',
      category: 'ASSEMBLY',
      description: '6S2P Li-ion pack, 21700 cells.',
      ageDays: 19,
    },
    { pn: 'ASM-1150', name: 'Camera Gimbal Assembly', category: 'ASSEMBLY', ageDays: 18 },
    { pn: 'ASM-1151', name: 'Camera Module', category: 'ASSEMBLY', ageDays: 18 },
    { pn: 'PUR-4006', name: 'Li-ion Cell 21700 5000mAh', category: 'PURCHASED', ageDays: 17 },
    { pn: 'ELE-3008', name: 'BMS Protection Board 6S', category: 'ELECTRICAL', ageDays: 17 },
    { pn: 'MEC-2007', name: 'Gimbal Frame, Magnesium', category: 'MECHANICAL', ageDays: 16 },
    { pn: 'ELE-3009', name: 'Gimbal Brushless Motor', category: 'ELECTRICAL', ageDays: 16 },
    { pn: 'ELE-3010', name: '4K Camera Sensor Board', category: 'ELECTRICAL', ageDays: 15 },
    { pn: 'MEC-2008', name: 'Camera Housing, Sealed', category: 'MECHANICAL', ageDays: 15 },
  ];

  const proIds = new Map<string, { id: number; revAId: number }>();
  for (const spec of PRO_PARTS) {
    const part = await prisma.part.create({
      data: {
        partNumber: spec.pn,
        name: spec.name,
        description: spec.description ?? null,
        category: spec.category,
        createdById: demo.id,
        createdAt: daysAgo(spec.ageDays),
        revisions: {
          create: {
            revision: 'A',
            lifecycle: 'RELEASED',
            createdById: demo.id,
            createdAt: daysAgo(spec.ageDays),
            releasedAt: daysAgo(Math.max(spec.ageDays - 2, 0)),
          },
        },
      },
      include: { revisions: true },
    });
    proIds.set(spec.pn, { id: part.id, revAId: part.revisions[0].id });
  }

  const childId = (pn: string): number => proIds.get(pn)?.id ?? sharedId.get(pn)!;
  const PRO_BOMS: { parent: string; lines: BomLineSpec[] }[] = [
    {
      parent: 'DRN-2000',
      lines: [
        { pn: 'ASM-1100', qty: 1 },
        { pn: 'ASM-1110', qty: 1 },
        { pn: 'ASM-1122', qty: 1 },
        { pn: 'ASM-1130', qty: 1 },
        { pn: 'ASM-1150', qty: 1 },
      ],
    },
    {
      parent: 'ASM-1122',
      lines: [
        { pn: 'ASM-1123', qty: 1 },
        { pn: 'ELE-3002', qty: 1, refDes: 'PDB1' },
        { pn: 'ELE-3003', qty: 2, refDes: 'W1,W2', notes: 'Dual harness for 6S current' },
      ],
    },
    {
      parent: 'ASM-1123',
      lines: [
        { pn: 'PUR-4006', qty: 12, notes: '6S2P configuration' },
        { pn: 'ELE-3008', qty: 1, refDes: 'BMS1' },
        { pn: 'MEC-2005', qty: 1 },
        { pn: 'RAW-5002', qty: 0.9, uom: 'm' },
      ],
    },
    {
      parent: 'ASM-1150',
      lines: [
        { pn: 'MEC-2007', qty: 1 },
        { pn: 'ELE-3009', qty: 3, refDes: 'GM1,GM2,GM3' },
        { pn: 'ASM-1151', qty: 1 },
      ],
    },
    {
      parent: 'ASM-1151',
      lines: [
        { pn: 'ELE-3010', qty: 1, refDes: 'CAM1' },
        { pn: 'MEC-2008', qty: 1 },
      ],
    },
  ];

  for (const bom of PRO_BOMS) {
    const parentRevId = proIds.get(bom.parent)!.revAId;
    for (let i = 0; i < bom.lines.length; i++) {
      const line = bom.lines[i];
      await prisma.bomLine.create({
        data: {
          parentRevisionId: parentRevId,
          childPartId: childId(line.pn),
          findNumber: (i + 1) * 10,
          quantity: line.qty,
          uom: line.uom ?? 'ea',
          refDesignators: line.refDes ?? null,
          notes: line.notes ?? null,
        },
      });
    }
  }

  console.log(`Seed: created TurboDrone X1 Pro (${PRO_PARTS.length} parts, 4-level eBOM)`);
}

// ===========================================================================
// Additive demo modules
//
// STRUCTURE. seed() returns early as soon as any Part exists, and it is the only
// thing that fills `seededParts` — so on an instance that already has the product
// data that map is empty and partOf() throws "unknown part number". Every module
// below is therefore a sibling of seed()/seedEcn()/seedX1Pro(), called from main()
// after them, and resolves everything by natural key (partNumber, email, docNumber,
// identifier, code) via findPart()/findUser(). A missing prerequisite is a quiet
// log and a return, never a throw.
//
// BOOT SAFETY. The container runs `prisma db push && node dist/seed.js && node
// dist/index.js`. main()'s catch sets process.exitCode = 1, which short-circuits the
// `&&` chain and the API never starts — so each module owns its own try/catch and
// swallows its failure. One bad module must not cost the other seven plus the server.
//
// IDEMPOTENCY. Each module opens with one cheap query so an already-seeded instance
// skips in a single round trip, then guards every row on its natural key behind that,
// so a half-applied run heals itself on the next boot rather than staying broken.
//
// NUMBER BANDS. Seeded rows use a 2xxxx band (DOC-20001, SN-20001, LOT-20001,
// SVC-20001) that cannot collide with anything the app has generated — every
// generator is scan-max and starts at 10001. Accepted side effect: after seeding,
// the next app-created document is DOC-20003, the next serial SN-20013, the next
// service record SVC-20004. The sequence jumps once; nothing breaks.
// ===========================================================================

interface FoundPart {
  id: number;
  revAId: number;
}

/** partOf() for the additive modules: by natural key, and null rather than a throw. */
async function findPart(pn: string): Promise<FoundPart | null> {
  const part = await prisma.part.findUnique({
    where: { partNumber: pn },
    include: { revisions: { where: { revision: 'A' } } },
  });
  if (!part || part.revisions.length === 0) return null;
  return { id: part.id, revAId: part.revisions[0].id };
}

/** Never hardcode a user id: a fresh instance and the live one do not agree on them. */
async function findUser(email: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { email } });
}

// ---------------------------------------------------------------------------
// Material master (rule N2)
// ---------------------------------------------------------------------------

interface MaterialSpec {
  code: string;
  name: string;
  materialClass: MaterialClass;
  specification: string;
  /** g/cm³. */
  density: number;
  stockUom: string;
  unitCost: number;
  active?: boolean;
  notes?: string;
}

/**
 * `code` must satisfy the route's /^[A-Z0-9._-]{2,32}$/i — letters, digits, dot, dash
 * and underscore only, so "PA66-GF30" rather than "PA66/GF30". It is immutable through
 * the API by design, and a material cannot be deleted once a part references it, so a
 * typo here is only fixable by hand.
 */
const MATERIAL_SPECS: MaterialSpec[] = [
  {
    code: 'AL-6061-T6',
    name: 'Aluminium 6061-T6',
    materialClass: 'METAL',
    specification: 'AL 6061-T6',
    density: 2.7,
    stockUom: 'kg',
    unitCost: 8.4,
  },
  {
    code: 'AL-7075-T651',
    name: 'Aluminium 7075-T651',
    materialClass: 'METAL',
    specification: 'AL 7075-T651',
    density: 2.81,
    stockUom: 'kg',
    unitCost: 14.9,
  },
  {
    code: 'CF-PREPREG-2',
    name: 'Carbon fibre prepreg, 2.0 mm laminate',
    materialClass: 'COMPOSITE',
    specification: 'T700/epoxy 2.0 mm, [0/90]4s',
    density: 1.55,
    stockUom: 'm2',
    unitCost: 62,
  },
  {
    code: 'ABS-FR',
    name: 'ABS, flame-retardant',
    materialClass: 'POLYMER',
    specification: 'ABS FR, UL94 V-0',
    density: 1.05,
    stockUom: 'kg',
    unitCost: 4.2,
  },
  // Deliberately used by NO part, so partCount stays 0 and the list can demonstrate the
  // 204 delete path — the one a material with parts hanging off it is refused (409).
  {
    code: 'PA66-GF30',
    name: 'Nylon 6/6, 30 % glass filled',
    materialClass: 'POLYMER',
    specification: 'PA66-GF30',
    density: 1.36,
    stockUom: 'kg',
    unitCost: 6.1,
  },
  {
    code: 'SS-A2-70',
    name: 'Stainless fastener stock, A2-70',
    materialClass: 'METAL',
    specification: 'ISO 3506-1 A2-70',
    density: 7.9,
    stockUom: 'kg',
    unitCost: 5.6,
  },
  {
    code: 'NI-201-STRIP',
    name: 'Nickel 201 strip, 8 x 0.15 mm',
    materialClass: 'METAL',
    specification: 'ASTM B162 Ni 201',
    density: 8.9,
    stockUom: 'm',
    unitCost: 1.35,
  },
  {
    code: 'MG-AZ31B',
    name: 'Magnesium AZ31B-H24',
    materialClass: 'METAL',
    specification: 'ASTM B90 AZ31B-H24',
    density: 1.78,
    stockUom: 'kg',
    unitCost: 21.5,
  },
  // The one inactive row, so the list's Active filter has something to filter. POST
  // /parts/:id/materials refuses an inactive material, so this one hangs on no part.
  {
    code: 'ABS-GP',
    name: 'ABS, general purpose (superseded)',
    materialClass: 'POLYMER',
    specification: 'ABS GP',
    density: 1.04,
    stockUom: 'kg',
    unitCost: 3.1,
    active: false,
    notes: 'Superseded by ABS-FR on the X1 programme.',
  },
];

async function seedMaterialCatalog(): Promise<void> {
  try {
    // Any material at all means someone owns this catalog — leave it alone.
    if ((await prisma.material.count()) > 0) {
      console.log('Seed: materials already present, skipping');
      return;
    }
    const owner =
      (await findUser('demo@turboplm.local')) ?? (await findUser('admin@turboplm.local'));
    if (!owner) {
      console.log('Seed: no demo user, skipping material catalog');
      return;
    }

    for (const spec of MATERIAL_SPECS) {
      // upsert on the unique code, so a run that died halfway through re-runs cleanly.
      await prisma.material.upsert({
        where: { code: spec.code },
        update: {},
        create: {
          code: spec.code,
          name: spec.name,
          materialClass: spec.materialClass,
          specification: spec.specification,
          density: spec.density,
          stockUom: spec.stockUom,
          unitCost: spec.unitCost,
          notes: spec.notes ?? null,
          active: spec.active ?? true,
          createdById: owner.id,
        },
      });
    }
    console.log(`Seed: created ${MATERIAL_SPECS.length} materials`);
  } catch (err) {
    console.error('Seed: material catalog failed', err);
  }
}

// ---------------------------------------------------------------------------
// What each part is made from (rules N2, N3)
// ---------------------------------------------------------------------------

interface PartMaterialSpec {
  pn: string;
  code: string;
  form: MaterialForm;
  /** In the MATERIAL's stockUom, not the part's uom. */
  net: number;
  /** Fraction lost to machining, trim or sprue; the route demands >= 0 and < 1. */
  scrap: number;
  stockSize?: string;
  notes?: string;
}

/**
 * Declared on the mechanical and raw parts of the X1 (and the two extra mechanical parts
 * the X1 Pro adds), so the material-requirements report on DRN-1000 rev A has real totals.
 *
 * `net` is in the MATERIAL's stockUom: CF-PREPREG-2 is m², so a carbon part's net is an
 * area, while AL-6061-T6 is kg so the motor mount's net is a mass. Mixing the two up gives
 * a report that adds up perfectly and is physically nonsense.
 *
 * Nothing is declared on an ASSEMBLY: the report adds a "…is an assembly carrying material
 * directly" note for those, which is a warning, not a feature. Declaring on ELECTRICAL or
 * PURCHASED parts is legal and contributes to the totals, but never clears a gap — the
 * report's unspecified list is computed over MECHANICAL and RAW_MATERIAL only.
 *
 * MEC-2006 Avionics Mounting Tray is ABSENT ON PURPOSE. It is the only MECHANICAL part in
 * the DRN-1000 rev A explosion left undeclared, so the report's amber "no material
 * declared" panel names exactly one part and the planning-gap story lands on a single
 * line instead of a wall of noise. Do not "fix" it by adding a row.
 */
const PART_MATERIAL_SPECS: PartMaterialSpec[] = [
  {
    pn: 'MEC-2001',
    code: 'CF-PREPREG-2',
    form: 'SHEET',
    net: 0.021,
    scrap: 0.2,
    stockSize: '260 x 90 mm blank, 2.0 mm sheet',
    notes: 'Two blanks per sheet width; trim allowance included in scrap.',
  },
  { pn: 'MEC-2002', code: 'CF-PREPREG-2', form: 'SHEET', net: 0.036, scrap: 0.25, stockSize: '220 x 190 mm blank' },
  { pn: 'MEC-2003', code: 'CF-PREPREG-2', form: 'SHEET', net: 0.041, scrap: 0.25, stockSize: '240 x 190 mm blank' },
  {
    pn: 'MEC-2004',
    code: 'AL-6061-T6',
    form: 'BAR',
    net: 0.043,
    scrap: 0.62,
    stockSize: '40 x 40 x 25 mm bar',
    notes: 'Machined from solid; chips are the bulk of the scrap.',
  },
  {
    pn: 'MEC-2005',
    code: 'ABS-FR',
    form: 'OTHER',
    net: 0.128,
    scrap: 0.06,
    stockSize: '25 kg pellet sack',
    notes: 'Injection moulded; scrap is sprue and runner.',
  },
  {
    pn: 'PUR-4001',
    code: 'SS-A2-70',
    form: 'OTHER',
    net: 0.0012,
    scrap: 0.02,
    stockSize: 'Cold-headed wire',
    notes: 'Material of record for mass and REACH roll-up — the fastener itself is purchased.',
  },
  {
    pn: 'RAW-5001',
    code: 'CF-PREPREG-2',
    form: 'SHEET',
    net: 1,
    scrap: 0.05,
    stockSize: '1250 mm wide roll',
    notes: 'Stock item: 1 m² of prepreg per 1 m² of sheet, 5 % edge trim.',
  },
  {
    pn: 'RAW-5002',
    code: 'NI-201-STRIP',
    form: 'PROFILE',
    net: 1,
    scrap: 0.1,
    stockSize: '8 x 0.15 mm strip, 25 m reel',
    notes: 'Weld-tab offcuts.',
  },
  // X1 Pro mechanical parts: without these the Pro's report shows three gaps, not one.
  { pn: 'MEC-2007', code: 'MG-AZ31B', form: 'PLATE', net: 0.052, scrap: 0.48, stockSize: '120 x 90 x 8 mm plate' },
  { pn: 'MEC-2008', code: 'ABS-FR', form: 'OTHER', net: 0.061, scrap: 0.06 },
];

/** Shared by seedPartMaterials and the one row seedRestrictedAccess owns. */
async function addPartMaterial(spec: PartMaterialSpec): Promise<boolean> {
  const part = await prisma.part.findUnique({ where: { partNumber: spec.pn }, select: { id: true } });
  const material = await prisma.material.findUnique({ where: { code: spec.code }, select: { id: true } });
  if (!part || !material) {
    console.log(`Seed: ${spec.pn} / ${spec.code} missing, skipping material declaration`);
    return false;
  }
  // The unique is (partId, materialId, form): the same alloy in two forms on one part is
  // two legitimate rows, which is why `form` is part of the guard rather than ignored.
  const existing = await prisma.partMaterial.findUnique({
    where: {
      partId_materialId_form: { partId: part.id, materialId: material.id, form: spec.form },
    },
    select: { id: true },
  });
  if (existing) return false;
  await prisma.partMaterial.create({
    data: {
      partId: part.id,
      materialId: material.id,
      form: spec.form,
      netQuantity: spec.net,
      scrapFactor: spec.scrap,
      stockSize: spec.stockSize ?? null,
      notes: spec.notes ?? null,
    },
  });
  return true;
}

async function seedPartMaterials(): Promise<void> {
  try {
    if ((await prisma.partMaterial.count()) > 0) {
      console.log('Seed: part materials already present, skipping');
      return;
    }
    let created = 0;
    for (const spec of PART_MATERIAL_SPECS) {
      if (await addPartMaterial(spec)) created += 1;
    }
    console.log(`Seed: declared material on ${created} parts (MEC-2006 left open on purpose)`);
  } catch (err) {
    console.error('Seed: part materials failed', err);
  }
}

// ---------------------------------------------------------------------------
// Item-level access control (rules X1, X6)
// ---------------------------------------------------------------------------

const RESTRICTED_GROUP = 'Payload Programme — Restricted';

/**
 * An access group, its members, and ONE restricted part.
 *
 * THE BLAST-RADIUS RULE: the restricted part is a peripheral orphan on purpose. PAY-6001
 * is referenced by no BomLine, no build unit and no document, so restricting it cannot
 * turn a BOM tree, a material report, a genealogy or a where-used view into a wall of
 * REDACTED rows for everyone outside the group. A single PartAcl on DRN-1000 or anything
 * under it would do exactly that — including for the read-only demo login.
 */
async function seedRestrictedAccess(): Promise<void> {
  try {
    if (await prisma.accessGroup.findUnique({ where: { name: RESTRICTED_GROUP } })) {
      console.log('Seed: restricted access demo already present, skipping');
      return;
    }
    const demo = await findUser('demo@turboplm.local');
    const admin = await findUser('admin@turboplm.local');
    if (!demo || !admin) {
      console.log('Seed: demo users missing, skipping restricted access demo');
      return;
    }

    // NEVER restrict a part this seed did not create. An acl row is opt-in: the FIRST grant
    // closes the item, so adopting a pre-existing PAY-6001 would take a real user's real part
    // and make it invisible to everyone outside the demo group — answering 404, which is
    // deliberately indistinguishable from deletion, with no way for them to self-recover.
    // A demo fixture is never worth that, so a name collision skips the module outright.
    const collision = await prisma.part.findUnique({
      where: { partNumber: 'PAY-6001' },
      select: { id: true },
    });
    if (collision) {
      console.log('Seed: PAY-6001 already exists and was not created here — skipping the access demo');
      return;
    }
    const part = await prisma.part.create({
      data: {
        partNumber: 'PAY-6001',
        name: 'Payload Adapter Plate, SkyWarden',
        description:
          'Customer-specific payload interface plate. Restricted to the payload programme.',
        category: 'MECHANICAL',
        uom: 'ea',
        createdById: demo.id,
        createdAt: daysAgo(9),
        revisions: {
          create: {
            revision: 'A',
            lifecycle: 'RELEASED',
            createdById: demo.id,
            createdAt: daysAgo(9),
            releasedAt: daysAgo(7),
          },
        },
      },
      select: { id: true },
    });

    const group = await prisma.accessGroup.upsert({
      where: { name: RESTRICTED_GROUP },
      update: {},
      create: {
        name: RESTRICTED_GROUP,
        description:
          'Cleared for the SkyWarden payload programme (customer NDA). Items granted to this group are invisible to everyone else.',
        // `active` is left at its default: an inactive group grants nothing.
        createdById: admin.id,
        createdAt: daysAgo(8),
      },
    });

    // Only the engineer. A global ADMIN passes every acl by rule X2, so listing Ada here
    // would change nothing and would wrongly suggest her access comes from the group. Val
    // Viewer is deliberately left out: she is the account that proves the restriction works,
    // because PAY-6001 simply does not exist as far as she is concerned.
    const existingMember = await prisma.accessGroupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId: demo.id } },
      select: { id: true },
    });
    if (!existingMember) {
      await prisma.accessGroupMember.create({
        data: { groupId: group.id, userId: demo.id, addedAt: daysAgo(8) },
      });
    }

    // Exactly one of groupId / userId per row (rule X1). The database would store both —
    // the two unique constraints work on NULL-distinctness — but lib/acl.ts reads such a
    // row as a deny: it restricts the item and grants nobody.
    const groupGrant = await prisma.partAcl.findUnique({
      where: { partId_groupId: { partId: part.id, groupId: group.id } },
      select: { id: true },
    });
    if (!groupGrant) {
      await prisma.partAcl.create({
        data: {
          partId: part.id,
          groupId: group.id,
          // WRITE implies READ, so the group needs no second row.
          permission: 'WRITE',
          grantedById: admin.id,
          grantedAt: daysAgo(6),
        },
      });
    }

    /*
     * Deliberately NO named-user grant here.
     *
     * Showing both principal kinds on the Access card is nice, but the only seeded account
     * available to receive one is Val Viewer — and granting it to her would destroy the far
     * more valuable demonstration: sign in as Val and PAY-6001 is simply not there. Not
     * greyed out, not "forbidden" — absent from the parts list, absent from search, 404 on a
     * direct link. That is the feature. A second grant row on a card is not worth trading it
     * for, and a grant can be added live in ten seconds if the card needs to show one.
     */

    // PAY-6001's own material row lives here rather than in PART_MATERIAL_SPECS because
    // the part is created by this module, which runs after seedPartMaterials.
    await addPartMaterial({
      pn: 'PAY-6001',
      code: 'AL-7075-T651',
      form: 'PLATE',
      net: 0.031,
      scrap: 0.55,
      stockSize: '160 x 120 x 6 mm plate',
    });

    console.log(`Seed: created access group "${RESTRICTED_GROUP}" restricting PAY-6001`);
  } catch (err) {
    console.error('Seed: restricted access failed', err);
  }
}

// ---------------------------------------------------------------------------
// Drawing sheets — the SVG files and the vault rows that point at them
// ---------------------------------------------------------------------------

const SHEET_W = 1190;
const SHEET_H = 842;

/** Opaque sheet plus the double border. Opaque because a transparent SVG looks broken. */
function sheetFrame(): string {
  return `<rect x="0" y="0" width="${SHEET_W}" height="${SHEET_H}" fill="#ffffff"/>
  <rect x="18" y="18" width="1154" height="806" fill="none" stroke="#1b2733" stroke-width="2.5"/>
  <rect x="30" y="30" width="1130" height="782" fill="none" stroke="#1b2733" stroke-width="1"/>`;
}

interface TitleBlockOpts {
  partNumber: string;
  title1: string;
  title2: string;
  drawnBy: string;
  date: string;
  scale: string;
  revision: string;
}

function titleBlock(o: TitleBlockOpts): string {
  return `<g font-family="Helvetica, Arial, sans-serif" fill="#1b2733">
    <rect x="800" y="652" width="360" height="160" fill="#ffffff" stroke="#1b2733" stroke-width="1.5"/>
    <line x1="800" y1="690" x2="1160" y2="690" stroke="#1b2733" stroke-width="1"/>
    <line x1="800" y1="742" x2="1160" y2="742" stroke="#1b2733" stroke-width="1"/>
    <line x1="800" y1="778" x2="1160" y2="778" stroke="#1b2733" stroke-width="1"/>
    <line x1="1000" y1="690" x2="1000" y2="742" stroke="#1b2733" stroke-width="1"/>
    <line x1="980" y1="742" x2="980" y2="778" stroke="#1b2733" stroke-width="1"/>
    <line x1="890" y1="778" x2="890" y2="812" stroke="#1b2733" stroke-width="1"/>
    <line x1="980" y1="778" x2="980" y2="812" stroke="#1b2733" stroke-width="1"/>
    <line x1="1080" y1="778" x2="1080" y2="812" stroke="#1b2733" stroke-width="1"/>
    <text x="812" y="678" font-size="14" font-weight="bold" letter-spacing="1.4">TURBOPLM DEMO — TURBODRONE X1</text>
    <text x="812" y="707" font-size="9" fill="#5a6b7d" letter-spacing="0.8">PART NUMBER</text>
    <text x="812" y="732" font-size="21" font-weight="bold">${o.partNumber}</text>
    <text x="1010" y="707" font-size="9" fill="#5a6b7d" letter-spacing="0.8">TITLE</text>
    <text x="1010" y="722" font-size="11">${o.title1}</text>
    <text x="1010" y="736" font-size="11">${o.title2}</text>
    <text x="812" y="757" font-size="9" fill="#5a6b7d" letter-spacing="0.8">DRAWN BY</text>
    <text x="812" y="772" font-size="12">${o.drawnBy}</text>
    <text x="990" y="757" font-size="9" fill="#5a6b7d" letter-spacing="0.8">DATE</text>
    <text x="990" y="772" font-size="12">${o.date}</text>
    <text x="812" y="792" font-size="9" fill="#5a6b7d">SCALE</text>
    <text x="812" y="806" font-size="12">${o.scale}</text>
    <text x="900" y="792" font-size="9" fill="#5a6b7d">SIZE</text>
    <text x="900" y="806" font-size="12">A3</text>
    <text x="990" y="792" font-size="9" fill="#5a6b7d">SHEET</text>
    <text x="990" y="806" font-size="12">1 OF 1</text>
    <text x="1090" y="792" font-size="9" fill="#5a6b7d">REV</text>
    <text x="1090" y="806" font-size="14" font-weight="bold">${o.revision}</text>
  </g>`;
}

const DIM_DEFS = `<defs>
    <marker id="dimArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#8a4b08"/>
    </marker>
  </defs>`;

function notesBlock(x: number, y: number, notes: string[]): string {
  const lines = notes
    .map((note, i) => `<text x="${x}" y="${y + 26 + i * 20}" font-size="12">${i + 1}. ${note}</text>`)
    .join('\n    ');
  return `<g font-family="Helvetica, Arial, sans-serif" fill="#1b2733">
    <text x="${x}" y="${y}" font-size="13" font-weight="bold" letter-spacing="1.2">NOTES</text>
    <line x1="${x}" y1="${y + 8}" x2="${x + 120}" y2="${y + 8}" stroke="#1b2733" stroke-width="1"/>
    ${lines}
  </g>`;
}

/**
 * The ASM-1100 frame layout sheet.
 *
 * SVG on purpose: previewKind() in the frontend treats svg/png/jpg as 'image', which
 * renders in an <img> the markup overlay can measure — that is what makes the BOX_2D and
 * POINT_2D anchors below legal AND visible. A .txt version degrades the markup panel to
 * NOTE-only (the existing DOC-10001 is exactly that dead end) and a .step would need the
 * CAD sidecar to convert before anything renders at all.
 *
 * Two features are placed deliberately, because seedMarkups anchors to them in normalized
 * 0-1 coordinates: the "32" dimension around (0.62, 0.31) and the fastener schedule around
 * (0.30, 0.72). Moving them moves the redlines off their subject.
 */
function frameLayoutSheet(revision: 'A' | 'B'): string {
  const arm = (angle: number): string => `<g transform="rotate(${angle} 680 360)">
      <rect x="740" y="347" width="150" height="26" rx="7" fill="#e8edf3" stroke="#1b2733" stroke-width="1.6"/>
      <line x1="726" y1="360" x2="904" y2="360" stroke="#8a4b08" stroke-width="0.8" stroke-dasharray="12 4 2 4"/>
      <circle cx="890" cy="360" r="27" fill="#f4f7fa" stroke="#1b2733" stroke-width="1.6"/>
      <circle cx="890" cy="360" r="13" fill="#ffffff" stroke="#1b2733" stroke-width="1.2"/>
      <circle cx="879" cy="349" r="3.4" fill="#ffffff" stroke="#1b2733" stroke-width="1"/>
      <circle cx="901" cy="349" r="3.4" fill="#ffffff" stroke="#1b2733" stroke-width="1"/>
      <circle cx="879" cy="371" r="3.4" fill="#ffffff" stroke="#1b2733" stroke-width="1"/>
      <circle cx="901" cy="371" r="3.4" fill="#ffffff" stroke="#1b2733" stroke-width="1"/>
    </g>`;

  const balloon = (cx: number, cy: number, find: string, tx: number, ty: number): string =>
    `<g font-family="Helvetica, Arial, sans-serif">
      <line x1="${cx}" y1="${cy}" x2="${tx}" y2="${ty}" stroke="#1b2733" stroke-width="1"/>
      <circle cx="${cx}" cy="${cy}" r="14" fill="#ffffff" stroke="#1b2733" stroke-width="1.4"/>
      <text x="${cx}" y="${cy + 5}" font-size="13" text-anchor="middle" fill="#1b2733">${find}</text>
    </g>`;

  const tableRow = (y: number, find: string, pn: string, desc: string, qty: string): string =>
    `<line x1="150" y1="${y}" x2="500" y2="${y}" stroke="#1b2733" stroke-width="0.8"/>
      <text x="158" y="${y + 14}" font-size="11">${find}</text>
      <text x="212" y="${y + 14}" font-size="11">${pn}</text>
      <text x="324" y="${y + 14}" font-size="11">${desc}</text>
      <text x="490" y="${y + 14}" font-size="11" text-anchor="end">${qty}</text>`;

  const notes = [
    'INTERPRET DRAWING PER ISO 8015. DIMENSIONS IN MILLIMETRES.',
    'ARMS BONDED AND BOLTED; CURE 24 h AT 23 °C BEFORE HANDLING.',
    'GENERAL TOLERANCE ±0.2 UNLESS OTHERWISE STATED.',
  ];
  // Note 4 exists only on version 2 — the redline thread on version 2 refers to the
  // revised sheet, and rule K1 says a markup belongs to a version, never a document.
  if (revision === 'B') notes.push('LOCTITE 243 ON ALL M3 FASTENERS, TORQUE 1.2 N·m');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SHEET_W} ${SHEET_H}" width="${SHEET_W}" height="${SHEET_H}">
  ${DIM_DEFS}
  ${sheetFrame()}
  <g>
    <line x1="440" y1="360" x2="920" y2="360" stroke="#8a4b08" stroke-width="0.7" stroke-dasharray="14 5 3 5"/>
    <line x1="680" y1="130" x2="680" y2="590" stroke="#8a4b08" stroke-width="0.7" stroke-dasharray="14 5 3 5"/>
    ${arm(-45)}
    ${arm(45)}
    ${arm(135)}
    ${arm(-135)}
    <rect x="568" y="268" width="224" height="184" rx="16" fill="#eef2f7" stroke="#1b2733" stroke-width="1.8"/>
    <rect x="596" y="292" width="168" height="136" rx="12" fill="#ffffff" stroke="#1b2733" stroke-width="1.6"/>
    <circle cx="680" cy="360" r="26" fill="none" stroke="#1b2733" stroke-width="1.2"/>
    <circle cx="680" cy="360" r="5" fill="none" stroke="#8a4b08" stroke-width="1"/>
  </g>
  <g font-family="Helvetica, Arial, sans-serif" fill="#8a4b08" stroke="#8a4b08">
    <line x1="748" y1="236" x2="800" y2="236" stroke-width="0.9"/>
    <line x1="748" y1="268" x2="800" y2="268" stroke-width="0.9"/>
    <line x1="784" y1="236" x2="784" y2="268" stroke-width="1.1" marker-start="url(#dimArrow)" marker-end="url(#dimArrow)"/>
    <text x="744" y="257" font-size="17" text-anchor="end" stroke="none">32</text>
    <line x1="568" y1="462" x2="568" y2="600" stroke-width="0.8"/>
    <line x1="792" y1="462" x2="792" y2="600" stroke-width="0.8"/>
    <line x1="568" y1="592" x2="792" y2="592" stroke-width="1.1" marker-start="url(#dimArrow)" marker-end="url(#dimArrow)"/>
    <text x="680" y="585" font-size="15" text-anchor="middle" stroke="none">224</text>
  </g>
  ${balloon(906, 152, '10', 846, 196)}
  ${balloon(486, 246, '20', 604, 300)}
  ${balloon(486, 478, '40', 608, 424)}
  <g font-family="Helvetica, Arial, sans-serif" fill="#1b2733">
    <text x="150" y="502" font-size="13" font-weight="bold" letter-spacing="1.2">FASTENER SCHEDULE</text>
    <rect x="150" y="512" width="350" height="120" fill="#ffffff" stroke="#1b2733" stroke-width="1.2"/>
    <rect x="150" y="512" width="350" height="20" fill="#eef2f7" stroke="#1b2733" stroke-width="1.2"/>
    <text x="158" y="526" font-size="10" letter-spacing="0.6">FIND</text>
    <text x="212" y="526" font-size="10" letter-spacing="0.6">PART NUMBER</text>
    <text x="324" y="526" font-size="10" letter-spacing="0.6">DESCRIPTION</text>
    <text x="490" y="526" font-size="10" letter-spacing="0.6" text-anchor="end">QTY</text>
    ${tableRow(532, '10', 'MEC-2001', 'CARBON FIBRE ARM', '4')}
    ${tableRow(552, '20', 'MEC-2002', 'CENTRE PLATE, TOP', '1')}
    ${tableRow(572, '30', 'MEC-2003', 'CENTRE PLATE, BTM', '1')}
    ${tableRow(592, '40', 'PUR-4001', 'M3x8 SHCS', '16')}
    ${tableRow(612, '50', 'RAW-5001', 'CF SHEET 2.0 mm', '0.15')}
    <line x1="204" y1="512" x2="204" y2="632" stroke="#1b2733" stroke-width="0.8"/>
    <line x1="316" y1="512" x2="316" y2="632" stroke="#1b2733" stroke-width="0.8"/>
    <line x1="444" y1="512" x2="444" y2="632" stroke="#1b2733" stroke-width="0.8"/>
  </g>
  ${notesBlock(60, 676, notes)}
  ${titleBlock({
    partNumber: 'ASM-1100',
    title1: 'FRAME ASSEMBLY',
    title2: 'LAYOUT',
    drawnBy: 'A. ADMIN',
    date: daysAgo(revision === 'B' ? 8 : 20).toISOString().slice(0, 10),
    scale: '1:2',
    revision,
  })}
</svg>
`;
}

/** The MEC-2001 detail sheet — the drawing the vault module checks out. */
function armDetailSheet(): string {
  const cutout = (cx: number): string =>
    `<ellipse cx="${cx}" cy="330" rx="34" ry="17" fill="#ffffff" stroke="#1b2733" stroke-width="1.4"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SHEET_W} ${SHEET_H}" width="${SHEET_W}" height="${SHEET_H}">
  ${DIM_DEFS}
  ${sheetFrame()}
  <g>
    <rect x="150" y="302" width="700" height="56" rx="26" fill="#e8edf3" stroke="#1b2733" stroke-width="1.8"/>
    <rect x="150" y="288" width="96" height="84" rx="10" fill="#dfe6ee" stroke="#1b2733" stroke-width="1.6"/>
    <circle cx="176" cy="310" r="5" fill="#ffffff" stroke="#1b2733" stroke-width="1.2"/>
    <circle cx="220" cy="310" r="5" fill="#ffffff" stroke="#1b2733" stroke-width="1.2"/>
    <circle cx="176" cy="350" r="5" fill="#ffffff" stroke="#1b2733" stroke-width="1.2"/>
    <circle cx="220" cy="350" r="5" fill="#ffffff" stroke="#1b2733" stroke-width="1.2"/>
    ${cutout(360)}
    ${cutout(470)}
    ${cutout(580)}
    <circle cx="800" cy="330" r="22" fill="#ffffff" stroke="#1b2733" stroke-width="1.6"/>
    <circle cx="800" cy="330" r="9.5" fill="none" stroke="#8a4b08" stroke-width="1"/>
    <line x1="120" y1="330" x2="880" y2="330" stroke="#8a4b08" stroke-width="0.7" stroke-dasharray="14 5 3 5"/>
    <rect x="150" y="470" width="700" height="26" rx="6" fill="#e8edf3" stroke="#1b2733" stroke-width="1.6"/>
    <g stroke="#1b2733" stroke-width="0.6" opacity="0.65">${Array.from(
      { length: 42 },
      (_, i) => `<line x1="${162 + i * 16}" y1="494" x2="${176 + i * 16}" y2="472"/>`
    ).join('')}</g>
    <rect x="150" y="470" width="700" height="26" rx="6" fill="none" stroke="#1b2733" stroke-width="1.6"/>
    <text x="500" y="536" font-size="13" font-family="Helvetica, Arial, sans-serif" text-anchor="middle" fill="#1b2733" letter-spacing="1.2">SECTION A-A — 2.0 mm LAMINATE, [0/90]4s</text>
  </g>
  <g font-family="Helvetica, Arial, sans-serif" fill="#8a4b08" stroke="#8a4b08">
    <line x1="150" y1="372" x2="150" y2="424" stroke-width="0.8"/>
    <line x1="850" y1="372" x2="850" y2="424" stroke-width="0.8"/>
    <line x1="150" y1="414" x2="850" y2="414" stroke-width="1.1" marker-start="url(#dimArrow)" marker-end="url(#dimArrow)"/>
    <text x="500" y="407" font-size="16" text-anchor="middle" stroke="none">248</text>
    <line x1="900" y1="302" x2="960" y2="302" stroke-width="0.8"/>
    <line x1="900" y1="358" x2="960" y2="358" stroke-width="0.8"/>
    <line x1="944" y1="302" x2="944" y2="358" stroke-width="1.1" marker-start="url(#dimArrow)" marker-end="url(#dimArrow)"/>
    <text x="978" y="336" font-size="16" text-anchor="end" stroke="none">28</text>
    <line x1="800" y1="308" x2="800" y2="228" stroke-width="0.8"/>
    <line x1="800" y1="236" x2="900" y2="236" stroke-width="1.1"/>
    <text x="908" y="241" font-size="15" stroke="none">Ø 19 THRU</text>
  </g>
  ${notesBlock(60, 606, [
    'INTERPRET DRAWING PER ISO 8015. DIMENSIONS IN MILLIMETRES.',
    'MATERIAL: CF-PREPREG-2, T700/EPOXY 2.0 mm, [0/90]4s.',
    'DEBURR AND SEAL ALL MACHINED EDGES WITH EPOXY PRIMER.',
    'WEIGHT-REDUCTION CUTOUTS PER ECN-10001 — NOT YET RELEASED.',
  ])}
  ${titleBlock({
    partNumber: 'MEC-2001',
    title1: 'CARBON FIBRE ARM',
    title2: 'DETAIL',
    drawnBy: 'D. ENGINEER',
    date: daysAgo(14).toISOString().slice(0, 10),
    scale: '1:1',
    revision: 'A',
  })}
</svg>
`;
}

interface SheetFile {
  /** Stable basename. NEVER the hrtime scheme the upload middleware uses. */
  storagePath: string;
  fileName: string;
  svg: string;
}

const SHEET_FILES: Record<'frameV1' | 'frameV2' | 'armV1', SheetFile> = {
  frameV1: {
    storagePath: 'seed-asm1100-frame-layout-v1.svg',
    fileName: 'ASM-1100-frame-layout-A.svg',
    svg: frameLayoutSheet('A'),
  },
  frameV2: {
    storagePath: 'seed-asm1100-frame-layout-v2.svg',
    fileName: 'ASM-1100-frame-layout-B.svg',
    svg: frameLayoutSheet('B'),
  },
  armV1: {
    storagePath: 'seed-mec2001-arm-detail-v1.svg',
    fileName: 'MEC-2001-arm-detail-A.svg',
    svg: armDetailSheet(),
  },
};

/**
 * Files on disk are NOT covered by the database guard: an instance whose uploads volume
 * was recreated has intact Document rows pointing at bytes that are gone. So this runs
 * before and independently of every DB check, and only writes what is missing.
 * absoluteStoragePath() basenames the path, which is why storagePath is a bare filename.
 */
function writeSheetFiles(): number {
  let written = 0;
  for (const sheet of Object.values(SHEET_FILES)) {
    const target = absoluteStoragePath(sheet.storagePath);
    if (fs.existsSync(target)) continue;
    fs.writeFileSync(target, sheet.svg, 'utf8');
    written += 1;
  }
  return written;
}

// ---------------------------------------------------------------------------
// Drawing documents in the vault (rules D1, K1)
// ---------------------------------------------------------------------------

/**
 * docNumber must match /^DOC-[0-9]{1,9}$/ to stay inside the app's scan-max generator;
 * a free-form number would be ignored by it and could later be re-issued to a second
 * document. DOC-20001 carries TWO versions on purpose: switching versions and watching
 * the redline threads change is what makes rule K1 visible.
 */
async function seedDrawingDocuments(): Promise<void> {
  try {
    const written = writeSheetFiles();
    if (written > 0) console.log(`Seed: wrote ${written} drawing sheet(s) to ${UPLOAD_DIR}`);

    if (await prisma.document.findUnique({ where: { docNumber: 'DOC-20001' } })) {
      console.log('Seed: drawing documents already present, skipping');
      return;
    }
    const demo = await findUser('demo@turboplm.local');
    const admin = await findUser('admin@turboplm.local');
    if (!demo || !admin) {
      console.log('Seed: demo users missing, skipping drawing documents');
      return;
    }

    const addVersion = async (
      documentId: number,
      version: number,
      sheet: SheetFile,
      uploadedById: number,
      createdAt: Date,
      note: string
    ): Promise<void> => {
      const existing = await prisma.documentVersion.findUnique({
        where: { documentId_version: { documentId, version } },
        select: { id: true },
      });
      if (existing) return;
      await prisma.documentVersion.create({
        data: {
          documentId,
          version,
          fileName: sheet.fileName,
          mimeType: 'image/svg+xml',
          // Int, and displayed — compute it rather than guess.
          sizeBytes: Buffer.byteLength(sheet.svg, 'utf8'),
          storagePath: sheet.storagePath,
          note,
          uploadedById,
          createdAt,
          // SKIPPED, not PENDING: queueConversion is only ever called from the routes, so
          // PENDING would leave the version looking like a conversion that never runs.
          conversionStatus: 'SKIPPED',
        },
      });
    };

    // Exactly one target per DocumentLink row — the mapper throws "DocumentLink N has no
    // target" for a row with none, which 500s the document detail page.
    const linkPart = async (documentId: number, pn: string): Promise<void> => {
      const part = await prisma.part.findUnique({ where: { partNumber: pn }, select: { id: true } });
      if (!part) return;
      const existing = await prisma.documentLink.findFirst({
        where: { documentId, partId: part.id },
        select: { id: true },
      });
      if (existing) return;
      await prisma.documentLink.create({ data: { documentId, partId: part.id } });
    };

    const layout = await prisma.document.upsert({
      where: { docNumber: 'DOC-20001' },
      update: {},
      create: {
        docNumber: 'DOC-20001',
        title: 'ASM-1100 Frame Assembly — Layout',
        category: 'DRAWING',
        description: 'General arrangement of the frame assembly, with the fastener schedule.',
        createdById: admin.id,
        createdAt: daysAgo(20),
      },
    });
    await addVersion(layout.id, 1, SHEET_FILES.frameV1, admin.id, daysAgo(20), 'First issue.');
    await addVersion(
      layout.id,
      2,
      SHEET_FILES.frameV2,
      admin.id,
      daysAgo(8),
      'Notes block updated; fastener table corrected.'
    );
    await linkPart(layout.id, 'ASM-1100');

    const detail = await prisma.document.upsert({
      where: { docNumber: 'DOC-20002' },
      update: {},
      create: {
        docNumber: 'DOC-20002',
        title: 'MEC-2001 Carbon Fibre Arm — Detail',
        category: 'DRAWING',
        description: 'Detail sheet for the carbon fibre arm, including the ECN-10001 cutouts.',
        createdById: demo.id,
        createdAt: daysAgo(14),
      },
    });
    await addVersion(detail.id, 1, SHEET_FILES.armV1, demo.id, daysAgo(14), 'First issue.');
    await linkPart(detail.id, 'MEC-2001');

    // The change that owns this sheet, when the ECN seed ran. Null-safe by lookup: never
    // assume a row from another module exists.
    const ecn = await prisma.ecn.findUnique({ where: { ecnNumber: 'ECN-10001' }, select: { id: true } });
    if (ecn) {
      const linked = await prisma.documentLink.findFirst({
        where: { documentId: detail.id, ecnId: ecn.id },
        select: { id: true },
      });
      if (!linked) await prisma.documentLink.create({ data: { documentId: detail.id, ecnId: ecn.id } });
    }

    console.log('Seed: created drawing documents DOC-20001 (2 versions) and DOC-20002');
  } catch (err) {
    console.error('Seed: drawing documents failed', err);
  }
}

// ---------------------------------------------------------------------------
// Redline review threads (rules K1, K2)
// ---------------------------------------------------------------------------

interface MarkupSpec {
  kind: MarkupKind;
  /**
   * Shape is fixed per kind by rule K1 and the seed writes it RAW, so nothing catches a
   * wrong one: NOTE -> {} exactly, POINT_2D -> { page, x, y }, BOX_2D -> { page, x, y, w, h }.
   * 2D coordinates are normalized 0-1 (a pixel value renders off-sheet and is refused on
   * any later edit) and `page` starts at 1, which is where the viewer's page state starts.
   */
  geometry: Prisma.InputJsonObject;
  status: MarkupStatus;
  by: 'demo' | 'admin';
  createdDaysAgo: number;
  /** RESOLVED and WONT_FIX write resolvedBy AND resolvedAt together, or the panel shows
   *  a resolver with no date. OPEN leaves both null. */
  resolvedBy?: 'demo' | 'admin';
  resolvedDaysAgo?: number;
  /** Never empty: the opening comment is what the list, the ECR escalation and the
   *  resolve notification all read, and PATCH 409s on a markup with none. */
  comments: { by: 'demo' | 'admin'; daysAgo: number; body: string }[];
}

const MARKUP_SPECS: MarkupSpec[] = [
  {
    // A box round the "32" dimension on the sheet. x + w and y + h stay <= 1 so the box
    // cannot hang off the edge of the drawing.
    kind: 'BOX_2D',
    geometry: { page: 1, x: 0.585, y: 0.255, w: 0.155, h: 0.115 },
    status: 'OPEN',
    by: 'admin',
    createdDaysAgo: 3,
    comments: [
      {
        by: 'admin',
        daysAgo: 3,
        body: 'This 32 mm is dimensioned from the plate edge. The CAD sketch drives it from datum B, so as drawn the arm pitch ends up about 1.5 mm out at the tip.',
      },
      {
        by: 'demo',
        daysAgo: 3,
        body: 'Confirmed against the model — it is a drawing error, not a model error. It goes on the next issue together with the ECN-10001 weight-reduction cutouts.',
      },
      { by: 'admin', daysAgo: 2, body: 'Agreed. Leave this open until that sheet is checked in.' },
    ],
  },
  {
    // A pin on the fastener schedule, settled.
    kind: 'POINT_2D',
    geometry: { page: 1, x: 0.305, y: 0.715 },
    status: 'RESOLVED',
    by: 'demo',
    createdDaysAgo: 5,
    resolvedBy: 'demo',
    resolvedDaysAgo: 4,
    comments: [
      {
        by: 'demo',
        daysAgo: 5,
        body: 'Find 40 lists 16 off M3x8, but each arm joint takes 4 and there are fasteners at the battery tray too. Is 16 right for this assembly?',
      },
      {
        by: 'admin',
        daysAgo: 5,
        body: '16 is right here — the tray fasteners sit on find 40 of ASM-1130, not on this drawing. Checked against the released BOM.',
      },
      { by: 'demo', daysAgo: 4, body: 'Understood, my mistake. Resolving.' },
    ],
  },
  {
    // A version-level remark: geometry is {} exactly, because a NOTE has no position.
    kind: 'NOTE',
    geometry: {},
    status: 'WONT_FIX',
    by: 'demo',
    createdDaysAgo: 6,
    resolvedBy: 'admin',
    resolvedDaysAgo: 6,
    comments: [
      { by: 'demo', daysAgo: 6, body: 'Should the title block carry the mass estimate?' },
      {
        by: 'admin',
        daysAgo: 6,
        body: 'Mass lives on the part record; we do not duplicate it on the sheet. Marking won’t fix.',
      },
    ],
  },
];

/**
 * Three threads on DOC-20001 VERSION 2 — one open, one resolved, one won't fix. The
 * frontend hides settled threads until "show resolved" is ticked, so the default view
 * shows exactly one live conversation; that is a tour-script note, not a reason to seed
 * them all as OPEN. No PIN_3D: the panel states plainly that 3D pins cannot be placed and
 * only lists them, and this document has no glTF derivative anyway.
 */
async function seedMarkups(): Promise<void> {
  try {
    // Markups have no natural key, so the seeded version carrying any markup is the signal.
    const existing = await prisma.markup.count({
      where: { documentVersion: { document: { docNumber: 'DOC-20001' } } },
    });
    if (existing > 0) {
      console.log('Seed: markups already present, skipping');
      return;
    }
    const demo = await findUser('demo@turboplm.local');
    const admin = await findUser('admin@turboplm.local');
    const document = await prisma.document.findUnique({
      where: { docNumber: 'DOC-20001' },
      select: { id: true },
    });
    if (!demo || !admin || !document) {
      console.log('Seed: DOC-20001 or its users missing, skipping markups');
      return;
    }
    const version = await prisma.documentVersion.findUnique({
      where: { documentId_version: { documentId: document.id, version: 2 } },
      select: { id: true },
    });
    if (!version) {
      console.log('Seed: DOC-20001 version 2 missing, skipping markups');
      return;
    }
    const userOf = (who: 'demo' | 'admin'): User => (who === 'admin' ? admin : demo);

    for (const spec of MARKUP_SPECS) {
      const markup = await prisma.markup.create({
        data: {
          documentVersionId: version.id,
          kind: spec.kind,
          geometry: spec.geometry,
          status: spec.status,
          createdById: userOf(spec.by).id,
          createdAt: daysAgo(spec.createdDaysAgo),
          resolvedById: spec.resolvedBy ? userOf(spec.resolvedBy).id : null,
          resolvedAt: spec.resolvedDaysAgo === undefined ? null : daysAgo(spec.resolvedDaysAgo),
        },
        select: { id: true },
      });
      // Comments are ordered by id ascending, so they are inserted in conversation order —
      // a Promise.all here would scramble the thread.
      for (const comment of spec.comments) {
        await prisma.markupComment.create({
          data: {
            markupId: markup.id,
            body: comment.body,
            createdById: userOf(comment.by).id,
            createdAt: daysAgo(comment.daysAgo),
          },
        });
      }
    }

    console.log(`Seed: created ${MARKUP_SPECS.length} markup threads on DOC-20001 v2`);
  } catch (err) {
    console.error('Seed: markups failed', err);
  }
}

// ---------------------------------------------------------------------------
// Vault check-out (rules D1, D2)
// ---------------------------------------------------------------------------

/**
 * DOC-20002 is checked out by the demo engineer, so the vault column is not empty and the
 * "checked out by / break lock / 409 on upload" paths are all demonstrable.
 *
 * DOC-20001 is deliberately left unlocked: rule D2 refuses a new version to anyone who
 * does not hold the lock, and a locked drawing complicates the markup screen for no gain.
 */
async function seedVaultCheckout(): Promise<void> {
  try {
    const demo = await findUser('demo@turboplm.local');
    if (!demo) {
      console.log('Seed: no demo engineer, skipping vault check-out');
      return;
    }
    /*
     * The guard IS the write: `lockedById: null` in the where clause makes it inherently
     * idempotent and means it can never steal a lock a real user has taken since. All four
     * columns go together — toLock() returns null unless lockedById, lockedBy and lockedAt
     * are all set, so a partial lock silently reads as "not checked out".
     *
     * lockExpiresAt is NOW + 5 days, consistent with the 7-day TTL against a lock taken two
     * days ago. A demo instance left running for a week shows the lock as expired — still
     * non-empty, still naming the holder.
     */
    const updated = await prisma.document.updateMany({
      where: { docNumber: 'DOC-20002', lockedById: null },
      data: {
        lockedById: demo.id,
        lockedAt: daysAgo(2),
        lockExpiresAt: new Date(NOW + 5 * DAY_MS),
        lockNote:
          'Adding the weight-reduction cutouts from ECN-10001 — revised sheet expected Friday.',
      },
    });
    if (updated.count === 0) {
      console.log('Seed: DOC-20002 absent or already checked out, skipping vault check-out');
      return;
    }
    console.log('Seed: checked DOC-20002 out to the demo engineer');
  } catch (err) {
    console.error('Seed: vault check-out failed', err);
  }
}

// ---------------------------------------------------------------------------
// Serialised build units and their as-built genealogy (rules U1, U3)
// ---------------------------------------------------------------------------

interface BuildUnitSpec {
  identifier: string;
  /** No schema default: omitting `kind` is a Prisma validation error at boot. */
  kind: BuildKind;
  pn: string;
  /** Defaults to IN_PROGRESS, which would block POST /service-records — always explicit. */
  status: BuildStatus;
  quantity?: number;
  builtDaysAgo: number;
  shippedDaysAgo?: number;
  notes?: string;
}

/**
 * One delivered aircraft with a mixed serial/lot genealogy, deep enough for the service
 * story to reach two levels down. Everything is built to revision A of its own part: the
 * units routes refuse an IN_WORK revision, so building to DRN-1000 rev B would create data
 * the app itself would not accept.
 *
 * The dates are pinned to the product data rather than chosen freely. The newest part in
 * the aircraft (RAW-5002 rev A) releases at daysAgo(21), so nothing may be built before
 * daysAgo(20) or the demo shows hardware built to a revision that did not exist yet. Hence
 * lots at 20, pods and the first pack at 19, sub-assemblies at 18, the aircraft built at 17
 * and shipped at 16 — comfortably before the service story, which starts at daysAgo(12).
 *
 * Identifiers stay inside /^SN-[0-9]{1,9}$/ and /^LOT-[0-9]{1,9}$/ so the scan-max
 * generator keeps working — the two prefixes have separate sequences, so after seeding
 * the next generated serial is SN-20013 and the next lot LOT-20018.
 */
const BUILD_UNIT_SPECS: BuildUnitSpec[] = [
  { identifier: 'SN-20001', kind: 'SERIAL', pn: 'DRN-1000', status: 'SHIPPED', builtDaysAgo: 17, shippedDaysAgo: 16, notes: 'SkyWarden trial fleet, aircraft 1.' },
  { identifier: 'SN-20002', kind: 'SERIAL', pn: 'ASM-1100', status: 'COMPLETED', builtDaysAgo: 18 },
  { identifier: 'SN-20003', kind: 'SERIAL', pn: 'ASM-1110', status: 'COMPLETED', builtDaysAgo: 18 },
  { identifier: 'SN-20004', kind: 'SERIAL', pn: 'ASM-1120', status: 'COMPLETED', builtDaysAgo: 18 },
  { identifier: 'SN-20005', kind: 'SERIAL', pn: 'ASM-1130', status: 'COMPLETED', builtDaysAgo: 18 },
  // Four motor pods were built; SN-20006 is the one that failed in service.
  {
    identifier: 'SN-20006',
    kind: 'SERIAL',
    pn: 'ASM-1111',
    // SCRAPPED because SVC-20001's swap sets scrapRemoved TRUE. The two must agree: the
    // route refuses to consume a SCRAPPED unit, and a mismatch would let a later reversal
    // silently resurrect written-off hardware.
    status: 'SCRAPPED',
    builtDaysAgo: 19,
    notes: 'Removed at SVC-20001; teardown confirmed bearing failure and it was written off.',
  },
  { identifier: 'SN-20007', kind: 'SERIAL', pn: 'ASM-1111', status: 'COMPLETED', builtDaysAgo: 19 },
  { identifier: 'SN-20008', kind: 'SERIAL', pn: 'ASM-1111', status: 'COMPLETED', builtDaysAgo: 19 },
  { identifier: 'SN-20009', kind: 'SERIAL', pn: 'ASM-1111', status: 'COMPLETED', builtDaysAgo: 19 },
  {
    identifier: 'SN-20010',
    kind: 'SERIAL',
    pn: 'ASM-1121',
    // Stays COMPLETED: it tested within spec. With no as-built line it is free to be
    // installed elsewhere, which is exactly what rule G2 preserves.
    status: 'COMPLETED',
    builtDaysAgo: 19,
    notes: 'Removed at SVC-20002; tested within spec and returned to stock.',
  },
  { identifier: 'SN-20011', kind: 'SERIAL', pn: 'ASM-1111', status: 'COMPLETED', builtDaysAgo: 14, notes: 'Replacement pod fitted at SVC-20001.' },
  { identifier: 'SN-20012', kind: 'SERIAL', pn: 'ASM-1121', status: 'COMPLETED', builtDaysAgo: 13, notes: 'Matched-cell pack fitted at SVC-20002.' },
  // Lots. A lot's quantity must cover everything consumed from it: LOT-20001 gives up
  // 8 + 8 = 16 of 400, so a live "record an as-built line" demo still has stock to draw on.
  { identifier: 'LOT-20001', kind: 'LOT', pn: 'PUR-4005', status: 'COMPLETED', quantity: 400, builtDaysAgo: 20 },
  { identifier: 'LOT-20002', kind: 'LOT', pn: 'PUR-4002', status: 'COMPLETED', quantity: 50, builtDaysAgo: 20 },
  { identifier: 'LOT-20003', kind: 'LOT', pn: 'PUR-4003', status: 'COMPLETED', quantity: 50, builtDaysAgo: 20 },
  { identifier: 'LOT-20004', kind: 'LOT', pn: 'ELE-3001', status: 'COMPLETED', quantity: 40, builtDaysAgo: 20 },
  { identifier: 'LOT-20005', kind: 'LOT', pn: 'ELE-3002', status: 'COMPLETED', quantity: 25, builtDaysAgo: 20 },
  { identifier: 'LOT-20006', kind: 'LOT', pn: 'ELE-3003', status: 'COMPLETED', quantity: 30, builtDaysAgo: 20 },
  // Lots for the frame and avionics content, so their deviation reports read MATCH rather
  // than MISSING on every planned line.
  { identifier: 'LOT-20007', kind: 'LOT', pn: 'MEC-2001', status: 'COMPLETED', quantity: 40, builtDaysAgo: 20 },
  { identifier: 'LOT-20008', kind: 'LOT', pn: 'MEC-2002', status: 'COMPLETED', quantity: 20, builtDaysAgo: 20 },
  { identifier: 'LOT-20009', kind: 'LOT', pn: 'MEC-2003', status: 'COMPLETED', quantity: 20, builtDaysAgo: 20 },
  { identifier: 'LOT-20010', kind: 'LOT', pn: 'PUR-4001', status: 'COMPLETED', quantity: 500, builtDaysAgo: 20 },
  { identifier: 'LOT-20011', kind: 'LOT', pn: 'RAW-5001', status: 'COMPLETED', quantity: 20, builtDaysAgo: 20 },
  { identifier: 'LOT-20012', kind: 'LOT', pn: 'ELE-3005', status: 'COMPLETED', quantity: 20, builtDaysAgo: 20 },
  { identifier: 'LOT-20013', kind: 'LOT', pn: 'ELE-3006', status: 'COMPLETED', quantity: 20, builtDaysAgo: 20 },
  { identifier: 'LOT-20014', kind: 'LOT', pn: 'MEC-2006', status: 'COMPLETED', quantity: 20, builtDaysAgo: 20 },
  // Battery pack content, so the pack the service story swaps reads MATCH rather than
  // three MISSING lines on the screen the tour lands on straight after SVC-20002.
  { identifier: 'LOT-20015', kind: 'LOT', pn: 'ELE-3004', status: 'COMPLETED', quantity: 20, builtDaysAgo: 20 },
  { identifier: 'LOT-20016', kind: 'LOT', pn: 'MEC-2005', status: 'COMPLETED', quantity: 20, builtDaysAgo: 20 },
  { identifier: 'LOT-20017', kind: 'LOT', pn: 'RAW-5002', status: 'COMPLETED', quantity: 30, builtDaysAgo: 20 },
];

interface AsBuiltSpec {
  parent: string;
  child: string;
  quantity: number;
  /**
   * Defaults to when the aircraft came together. The two replacements were recorded at
   * swap time, and the replacement pack's own content at the time that pack was built —
   * a line recorded before its parent existed is the kind of detail that reads as noise.
   */
  recordedDaysAgo?: number;
}

/**
 * THE ONE THAT MATTERS: this graph is the POST-SWAP state. A swap deletes the removed
 * unit's as-built line and creates the replacement's, so SN-20006 has NO line into
 * SN-20003 and SN-20010 has NO line into SN-20004 — they were pulled out. Recording both
 * the removed and the installed unit would break the single-parent rule for serials,
 * double the planned quantity on the deviation report, and make the as-maintained log
 * disagree with the genealogy, which is the exact failure rule G2 exists to prevent.
 *
 * The motor pods carry no internal record on purpose: a genealogy that bottoms out
 * somewhere is realistic, and their deviation reports are then the one place in the demo
 * that shows what an unrecorded build looks like.
 */
const AS_BUILT_SPECS: AsBuiltSpec[] = [
  { parent: 'SN-20001', child: 'SN-20002', quantity: 1 },
  { parent: 'SN-20001', child: 'SN-20003', quantity: 1 },
  { parent: 'SN-20001', child: 'SN-20004', quantity: 1 },
  { parent: 'SN-20001', child: 'SN-20005', quantity: 1 },
  // Frame content.
  { parent: 'SN-20002', child: 'LOT-20007', quantity: 4 },
  { parent: 'SN-20002', child: 'LOT-20008', quantity: 1 },
  { parent: 'SN-20002', child: 'LOT-20009', quantity: 1 },
  { parent: 'SN-20002', child: 'LOT-20010', quantity: 16 },
  { parent: 'SN-20002', child: 'LOT-20011', quantity: 0.15 },
  // Propulsion: three original pods plus the replacement. SN-20006 is absent.
  { parent: 'SN-20003', child: 'SN-20007', quantity: 1 },
  { parent: 'SN-20003', child: 'SN-20008', quantity: 1 },
  { parent: 'SN-20003', child: 'SN-20009', quantity: 1 },
  { parent: 'SN-20003', child: 'SN-20011', quantity: 1, recordedDaysAgo: 10 },
  { parent: 'SN-20003', child: 'LOT-20002', quantity: 2 },
  { parent: 'SN-20003', child: 'LOT-20003', quantity: 2 },
  { parent: 'SN-20003', child: 'LOT-20004', quantity: 4 },
  // Power module: the replacement pack. SN-20010 is absent.
  { parent: 'SN-20004', child: 'SN-20012', quantity: 1, recordedDaysAgo: 8 },
  { parent: 'SN-20004', child: 'LOT-20005', quantity: 1 },
  { parent: 'SN-20004', child: 'LOT-20006', quantity: 1 },
  // Avionics content.
  { parent: 'SN-20005', child: 'LOT-20012', quantity: 1 },
  { parent: 'SN-20005', child: 'LOT-20013', quantity: 1 },
  { parent: 'SN-20005', child: 'LOT-20014', quantity: 1 },
  { parent: 'SN-20005', child: 'LOT-20010', quantity: 8 },
  // The same lots feed both packs — one lot may feed many parents (AsBuiltLine is unique
  // on (parentId, childId), not on childId), and the removed pack keeps its own genealogy
  // after being pulled out of the aircraft.
  { parent: 'SN-20012', child: 'LOT-20001', quantity: 8, recordedDaysAgo: 13 },
  { parent: 'SN-20012', child: 'LOT-20015', quantity: 1, recordedDaysAgo: 13 },
  { parent: 'SN-20012', child: 'LOT-20016', quantity: 1, recordedDaysAgo: 13 },
  { parent: 'SN-20012', child: 'LOT-20017', quantity: 0.6, recordedDaysAgo: 13 },
  { parent: 'SN-20010', child: 'LOT-20001', quantity: 8 },
  { parent: 'SN-20010', child: 'LOT-20015', quantity: 1 },
  { parent: 'SN-20010', child: 'LOT-20016', quantity: 1 },
  { parent: 'SN-20010', child: 'LOT-20017', quantity: 0.6 },
];

/**
 * Returns true when the demo build units are the seed's own — the precondition for
 * seeding service history, which writes swaps that rewrite as-built genealogy.
 */
async function seedBuildUnits(): Promise<boolean> {
  try {
    if (await prisma.buildUnit.findUnique({ where: { identifier: 'SN-20001' } })) {
      // Present from a previous run of this seed, so the demo genealogy is ours to build on.
      console.log('Seed: build units already present, skipping');
      return true;
    }
    const demo = await findUser('demo@turboplm.local');
    if (!demo) {
      console.log('Seed: no demo engineer, skipping build units');
      return false;
    }

    const unitSelect = { id: true, partId: true, partRevisionId: true } as const;
    const units = new Map<string, { id: number; partId: number; partRevisionId: number }>();
    let createdUnits = 0;

    for (const spec of BUILD_UNIT_SPECS) {
      const existing = await prisma.buildUnit.findUnique({
        where: { identifier: spec.identifier },
        select: unitSelect,
      });
      if (existing) {
        /*
         * A unit with this identifier exists but this run did not create it, so it is real
         * hardware someone recorded by hand — identifiers are user-suppliable. Adopting it
         * into the demo genealogy would write raw AsBuiltLine rows against it, bypassing
         * every invariant units.ts enforces under an advisory lock: one parent per serial,
         * no lot over-draw, parent must be IN_PROGRESS, no cycles. The database enforces
         * none of those, so the damage would be silent and permanent — a real serial with
         * two parents can never be reopened or re-consumed. Skip the module instead.
         */
        console.log(
          `Seed: ${spec.identifier} already exists and was not created here — skipping build units`
        );
        return false;
      }
      const part = await findPart(spec.pn);
      if (!part) {
        console.log(`Seed: ${spec.pn} missing, skipping build unit ${spec.identifier}`);
        continue;
      }
      const created = await prisma.buildUnit.create({
        data: {
          kind: spec.kind,
          identifier: spec.identifier,
          partId: part.id,
          partRevisionId: part.revAId,
          // A SERIAL is always quantity 1; a LOT carries its batch size.
          quantity: spec.quantity ?? 1,
          status: spec.status,
          builtAt: daysAgo(spec.builtDaysAgo),
          shippedAt: spec.shippedDaysAgo === undefined ? null : daysAgo(spec.shippedDaysAgo),
          notes: spec.notes ?? null,
          createdById: demo.id,
          createdAt: daysAgo(spec.builtDaysAgo),
        },
        select: unitSelect,
      });
      units.set(spec.identifier, created);
      createdUnits += 1;
    }

    let lines = 0;
    for (const spec of AS_BUILT_SPECS) {
      const parent = units.get(spec.parent);
      const child = units.get(spec.child);
      if (!parent || !child) continue;
      const existing = await prisma.asBuiltLine.findUnique({
        where: { parentId_childId: { parentId: parent.id, childId: child.id } },
        select: { id: true },
      });
      if (existing) continue;
      /*
       * The BOM line must belong to the revision the PARENT was built to — a line from a
       * later revision under a parent built to rev A is refused by the route and makes the
       * deviation report nonsense. Resolving it through the parent unit's own
       * partRevisionId gets that right by construction, and never hardcodes an id: the live
       * instance's ids are not a fresh instance's.
       */
      const bomLine = await prisma.bomLine.findFirst({
        where: { parentRevisionId: parent.partRevisionId, childPartId: child.partId },
        select: { id: true },
      });
      await prisma.asBuiltLine.create({
        data: {
          parentId: parent.id,
          childId: child.id,
          quantity: spec.quantity,
          bomLineId: bomLine?.id ?? null,
          // Computed as bomLine.childPartId !== child.partId; every line here is
          // like-for-like, so setting it true by hand would paint fake deviations.
          substitution: false,
          recordedById: demo.id,
          recordedAt: daysAgo(spec.recordedDaysAgo ?? 18),
        },
      });
      lines += 1;
    }

    console.log(`Seed: created ${createdUnits} build units and ${lines} as-built lines`);
    return true;
  } catch (err) {
    console.error('Seed: build units failed', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Service history (rules G1, G2, G3)
// ---------------------------------------------------------------------------

interface ServiceSwapSpec {
  removed?: string;
  installed?: string;
  position: string;
  reason: string;
  /** EXPLICIT, and must agree with the removed unit's status. Never inferred from prose. */
  scrapRemoved: boolean;
  performedDaysAgo: number;
}

interface ServiceRecordSpec {
  serviceNumber: string;
  unit: string;
  kind: ServiceKind;
  status: ServiceStatus;
  title: string;
  description: string;
  reportedDaysAgo: number;
  /** CLOSED and closedAt are one consistent pair; the API refuses any later PATCH. */
  closedDaysAgo?: number;
  technician: 'demo' | 'admin';
  createdBy: 'demo' | 'admin';
  /** Looked up by ecnNumber, null when the ECN seed did not run. */
  ecnNumber?: string;
  swaps: ServiceSwapSpec[];
}

/**
 * Three records against the delivered aircraft. The swap rows are the LOG of an edit
 * seedBuildUnits already baked into the as-built graph — they do not perform it. The two
 * must be seeded together or the as-maintained view and the genealogy disagree, which is
 * the one failure mode rule G2 calls unacceptable.
 *
 * Both swaps remove a unit that WAS inside SN-20001 (transitively: the pod sits inside the
 * propulsion assembly, the pack two levels down inside the power module) and install a
 * replacement that is inside it now. Both install something, so neither is irreversible —
 * a swap with a removal and no install cannot be undone through the API, because the
 * position it came out of is unrecoverable.
 */
const SERVICE_RECORD_SPECS: ServiceRecordSpec[] = [
  // ORDER MATTERS: GET /service-records sorts by id descending, so the record seeded
  // LAST is the one a visitor (and the recorded tour) sees at the top of the list.
  // The swap-less inspection therefore goes first — landing on it would put an empty
  // "no parts have been swapped" panel under the swap story this module exists to tell.
  {
    serviceNumber: 'SVC-20003',
    unit: 'SN-20001',
    kind: 'INSPECTION',
    status: 'IN_PROGRESS',
    title: '50-hour airframe inspection',
    description:
      'Scheduled inspection: arm bonding, motor mount torque check, battery bay corrosion.',
    reportedDaysAgo: 2,
    technician: 'demo',
    createdBy: 'admin',
    // No swaps, and not CLOSED: the Service list is then not uniformly settled and the
    // status filter has something to filter.
    swaps: [],
  },
  {
    serviceNumber: 'SVC-20001',
    unit: 'SN-20001',
    kind: 'REPAIR',
    status: 'CLOSED',
    // "first 40 flight hours" rather than a bigger number: the aircraft shipped at
    // daysAgo(16) and this is raised at daysAgo(12), so a four-figure hour count would
    // not survive anyone doing the arithmetic on screen.
    title: 'Front-left motor pod vibration in the first 40 flight hours',
    description:
      'Customer reported increasing vibration and a yaw drift in hover. Ground run reproduced it on M1. Pod replaced as a unit; the removed pod was returned to the depot, teardown confirmed bearing failure and it was written off.',
    reportedDaysAgo: 12,
    closedDaysAgo: 9,
    technician: 'demo',
    createdBy: 'admin',
    swaps: [
      {
        removed: 'SN-20006',
        installed: 'SN-20011',
        position: 'Front-left arm (M1)',
        reason: 'Bearing play in the 2216 motor; pod replaced as a unit and written off after teardown.',
        scrapRemoved: true,
        performedDaysAgo: 10,
      },
    ],
  },
  {
    serviceNumber: 'SVC-20002',
    unit: 'SN-20001',
    kind: 'UPGRADE',
    status: 'CLOSED',
    title: 'Battery pack swapped under the 4S2P capacity programme',
    description:
      'Pack replaced with a matched-cell pack from the current build. The removed pack tested within spec and went back to stock.',
    reportedDaysAgo: 9,
    closedDaysAgo: 8,
    technician: 'demo',
    createdBy: 'demo',
    // Deliberately NOT linked to ECN-10001: that change is seeded as a DRAFT dated after
    // this record closed, and about a different subject entirely. A closed upgrade citing a
    // draft change from the future is the first inconsistency a PLM buyer would spot.
    swaps: [
      {
        removed: 'SN-20010',
        installed: 'SN-20012',
        // Two levels down, yet the record is raised against the AIRCRAFT and the change
        // still lands in the aircraft's as-maintained log — the self-erasing-log case.
        position: 'Battery bay, inside ASM-1120',
        reason: 'Capacity programme rollout; removed pack tested within spec and returned to stock.',
        scrapRemoved: false,
        performedDaysAgo: 8,
      },
    ],
  },
];

async function seedServiceHistory(): Promise<void> {
  try {
    if (await prisma.serviceRecord.findUnique({ where: { serviceNumber: 'SVC-20001' } })) {
      console.log('Seed: service records already present, skipping');
      return;
    }
    const demo = await findUser('demo@turboplm.local');
    const admin = await findUser('admin@turboplm.local');
    if (!demo || !admin) {
      console.log('Seed: demo users missing, skipping service history');
      return;
    }
    const userOf = (who: 'demo' | 'admin'): User => (who === 'admin' ? admin : demo);
    const unitId = async (identifier: string): Promise<number | null> => {
      const unit = await prisma.buildUnit.findUnique({
        where: { identifier },
        select: { id: true },
      });
      return unit?.id ?? null;
    };

    let created = 0;
    for (const spec of SERVICE_RECORD_SPECS) {
      // Never raise a record against a unit that is not there.
      const buildUnitId = await unitId(spec.unit);
      if (buildUnitId === null) {
        console.log(`Seed: ${spec.unit} missing, skipping ${spec.serviceNumber}`);
        continue;
      }
      const ecn = spec.ecnNumber
        ? await prisma.ecn.findUnique({ where: { ecnNumber: spec.ecnNumber }, select: { id: true } })
        : null;

      let record = await prisma.serviceRecord.findUnique({
        where: { serviceNumber: spec.serviceNumber },
        select: { id: true },
      });
      if (!record) {
        record = await prisma.serviceRecord.create({
          data: {
            serviceNumber: spec.serviceNumber,
            buildUnitId,
            kind: spec.kind,
            status: spec.status,
            title: spec.title,
            description: spec.description,
            reportedAt: daysAgo(spec.reportedDaysAgo),
            closedAt: spec.closedDaysAgo === undefined ? null : daysAgo(spec.closedDaysAgo),
            technicianId: userOf(spec.technician).id,
            createdById: userOf(spec.createdBy).id,
            ecnId: ecn?.id ?? null,
            createdAt: daysAgo(spec.reportedDaysAgo),
          },
          select: { id: true },
        });
        created += 1;
      }

      for (const swap of spec.swaps) {
        const removedUnitId = swap.removed ? await unitId(swap.removed) : null;
        const installedUnitId = swap.installed ? await unitId(swap.installed) : null;
        /*
         * A named unit that does not resolve means the build-unit module did not finish.
         * Skip the whole swap rather than write the half of it that resolved: a removal
         * with no installation is deliberately irreversible through the API (the position
         * it came out of is unrecoverable), so a silently truncated swap is worse than none.
         */
        if ((swap.removed && removedUnitId === null) || (swap.installed && installedUnitId === null)) {
          console.log(`Seed: units for ${spec.serviceNumber} missing, skipping its swap`);
          continue;
        }
        // A swap must remove something, install something, or both.
        if (removedUnitId === null && installedUnitId === null) continue;
        // Swaps have no natural key, so they are guarded on their parent and their units.
        const existing = await prisma.servicePartSwap.findFirst({
          where: { serviceRecordId: record.id, removedUnitId, installedUnitId },
          select: { id: true },
        });
        if (existing) continue;
        await prisma.servicePartSwap.create({
          data: {
            serviceRecordId: record.id,
            removedUnitId,
            installedUnitId,
            position: swap.position,
            reason: swap.reason,
            scrapRemoved: swap.scrapRemoved,
            performedById: demo.id,
            performedAt: daysAgo(swap.performedDaysAgo),
          },
        });
      }
    }

    console.log(`Seed: created ${created} service records with their part swaps`);
  } catch (err) {
    console.error('Seed: service history failed', err);
  }
}

/**
 * Demo data (including well-known demo logins whose passwords are published in the
 * README) must never be created on an internet-facing instance. Set
 * SEED_DEMO_DATA=false there and create the first admin with `npm run create-admin`.
 */
const SEED_DEMO_DATA = process.env.SEED_DEMO_DATA !== 'false';

async function main(): Promise<void> {
  try {
    if (!SEED_DEMO_DATA) {
      console.log('Seed: SEED_DEMO_DATA=false — skipping all demo data and demo logins');
      return;
    }
    await seed();
    await seedEcn();
    await seedX1Pro();
    /*
     * Additive modules, in dependency order: the material catalog before anything that
     * declares material, the access module before nothing (its part is an orphan by
     * design, but it owns one material row so it follows the catalog), documents before
     * the markups anchored to them and the lock taken on them, and the build units before
     * the service records whose swaps log edits to their genealogy.
     *
     * Each swallows its own failure, so this list is not a chain: a module that dies still
     * leaves the others — and the API process that starts after this one exits — intact.
     */
    await seedMaterialCatalog();
    await seedPartMaterials();
    await seedRestrictedAccess();
    await seedDrawingDocuments();
    await seedMarkups();
    await seedVaultCheckout();
    // Service history writes swaps that REWRITE as-built genealogy, so it may only run when
    // the units it references are the seed's own. If a real unit already held one of the demo
    // identifiers, seedBuildUnits bails out and this must not proceed against real hardware.
    const ownsBuildUnits = await seedBuildUnits();
    if (ownsBuildUnits) await seedServiceHistory();
    else console.log('Seed: build units are not seed-owned — skipping service history');
  } catch (err) {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
