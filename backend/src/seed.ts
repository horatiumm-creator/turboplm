/**
 * TurboPLM seed script — compiled to dist/seed.js and run before the server starts.
 *
 * Idempotent: exits early when any Part already exists. Creates the demo users and
 * the TurboDrone X1 quadcopter demo product: ~25 parts in a 4-level eBOM, the top
 * assembly with rev A RELEASED and rev B IN_WORK, mixed leaf lifecycles (consistent
 * with the release gate: every BOM child of a RELEASED parent has a RELEASED
 * revision), and process plans for the battery pack and the top assembly.
 */
import bcrypt from 'bcryptjs';
import { Lifecycle, PartCategory, Role, User } from '@prisma/client';
import { prisma } from './lib/prisma';

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

async function main(): Promise<void> {
  try {
    await seed();
    await seedEcn();
    await seedX1Pro();
  } catch (err) {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
