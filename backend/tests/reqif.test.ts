/**
 * ReqIF 1.2 import and export.
 *
 * The centrepiece is the round trip, and it deliberately DELETES the requirements between the
 * export and the import rather than re-importing on top of them. A round trip over surviving
 * rows proves much less than it looks like it does: the requirements are already there, the
 * ids still match, and an importer that quietly matched on id instead of on reqNumber would
 * pass. Emptying the table first forces every identifier to be resolved from the document —
 * the tree included, which in ReqIF exists only as SPEC-HIERARCHY nesting and nowhere else —
 * and because `deleteMany` does not restart the id sequence, the rows come back with ids that
 * are not the ones the file was written from.
 *
 * The rest of the file covers the promises the endpoints make that a happy-path round trip
 * cannot: that a foreign tool's attributes are dropped but counted, that a malformed file
 * writes nothing at all, that re-importing updates rather than duplicates, and that neither
 * the export nor the import is a way around item-level ACLs (rules X1, X4) or change control
 * (rule R3).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AclPermission,
  EcnPriority,
  PartCategory,
  RequirementStatus,
  RequirementType,
  Role,
} from '@prisma/client';
import { prisma } from './helpers/db';
import { Client, createAndLogin } from './helpers/api';
import { parseReqifDocument } from '../src/lib/reqif';

const IMPORT_PATH = '/api/requirements/import/reqif';
const EXPORT_PATH = '/api/requirements/export/reqif';

let engineer: Client;

beforeEach(async () => {
  engineer = await createAndLogin({ role: Role.ENGINEER });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface RequirementSeed {
  reqNumber: string;
  title?: string;
  statement?: string;
  type?: RequirementType;
  priority?: EcnPriority;
  status?: RequirementStatus;
  rationale?: string | null;
  acceptance?: string | null;
  parentId?: number | null;
}

async function seedRequirement(seed: RequirementSeed): Promise<{ id: number; reqNumber: string }> {
  return prisma.requirement.create({
    data: {
      reqNumber: seed.reqNumber,
      title: seed.title ?? `Title for ${seed.reqNumber}`,
      statement: seed.statement ?? `Statement for ${seed.reqNumber}`,
      type: seed.type ?? RequirementType.FUNCTIONAL,
      priority: seed.priority ?? EcnPriority.MEDIUM,
      status: seed.status ?? RequirementStatus.DRAFT,
      rationale: seed.rationale ?? null,
      acceptance: seed.acceptance ?? null,
      parentId: seed.parentId ?? null,
      createdById: engineer.id,
    },
    select: { id: true, reqNumber: true },
  });
}

/**
 * Empty the requirement table, leaving everything else — users, parts, documents — alone.
 *
 * Deliberately `deleteMany` and not `resetDatabase()`: the session has to survive, and the id
 * sequence has to keep going, so that what the import writes cannot land on the ids the
 * exported file was built from.
 */
async function clearRequirements(): Promise<void> {
  await prisma.requirement.deleteMany();
}

/** Export as the given session and return the raw document. */
async function exportReqif(client: Client = engineer): Promise<string> {
  const res = await client.get(EXPORT_PATH);
  expect(res.status).toBe(200);
  return res.text;
}

/** Upload a document as a multipart file, the way the frontend will. */
function importReqif(client: Client, xml: string, filename = 'requirements.reqif') {
  return client.post(IMPORT_PATH).attach('file', Buffer.from(xml, 'utf8'), filename);
}

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

describe('ReqIF round trip through the file', () => {
  /**
   * A three-level tree with every optional field populated somewhere and every field left
   * null somewhere, so a mapper that confuses "absent" with "empty string" fails here rather
   * than in production.
   */
  async function seedTree() {
    const root = await seedRequirement({
      reqNumber: 'REQ-10001',
      title: 'Braking system shall stop the vehicle',
      // Deliberately multi-line and full of characters XML has to escape.
      statement: 'The system shall stop within 40 m.\nMeasured at 100 km/h & < 2 g deceleration.',
      type: RequirementType.SAFETY,
      priority: EcnPriority.CRITICAL,
      status: RequirementStatus.APPROVED,
      rationale: 'Regulatory: ECE R13H "quoted" clause 2.1',
      acceptance: 'Track test at 100 km/h on dry tarmac',
    });
    const child = await seedRequirement({
      reqNumber: 'REQ-10002',
      title: 'Pedal force limit',
      statement: 'Pedal force shall not exceed 500 N.',
      type: RequirementType.PERFORMANCE,
      priority: EcnPriority.HIGH,
      parentId: root.id,
      // rationale null, acceptance set — the opposite of the grandchild below.
      acceptance: 'Bench measurement',
    });
    const grandchild = await seedRequirement({
      reqNumber: 'REQ-10003',
      title: 'Pedal travel',
      statement: 'Pedal travel shall be between 60 mm and 90 mm.',
      type: RequirementType.INTERFACE,
      priority: EcnPriority.LOW,
      parentId: child.id,
      rationale: 'Ergonomics study 2026-02',
    });
    // A second root, to prove the hierarchy carries more than one top-level branch.
    const secondRoot = await seedRequirement({
      reqNumber: 'REQ-10004',
      title: 'Diagnostics interface',
      statement: 'The ECU shall expose UDS service 0x22.',
      type: RequirementType.REGULATORY,
      priority: EcnPriority.MEDIUM,
    });
    return { root, child, grandchild, secondRoot };
  }

  it('carries the tree and every field back into an empty table', async () => {
    await seedTree();
    const xml = await exportReqif();
    const source = await prisma.requirement.findMany({ orderBy: { reqNumber: 'asc' } });

    await clearRequirements();
    const res = await importReqif(engineer, xml);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 4, updated: 0, skipped: 0 });

    const imported = await prisma.requirement.findMany({ orderBy: { reqNumber: 'asc' } });
    expect(imported).toHaveLength(4);
    // The rows really are new ones: nothing was matched by id, because no id survived.
    expect(imported.map((row) => row.id)).not.toEqual(source.map((row) => row.id));

    // Ids differ by construction, so the tree is compared by reqNumber.
    const reqNumberById = new Map(imported.map((row) => [row.id, row.reqNumber]));
    const sourceReqNumberById = new Map(source.map((row) => [row.id, row.reqNumber]));

    for (const [index, original] of source.entries()) {
      const copy = imported[index];
      expect(copy.reqNumber).toBe(original.reqNumber);
      expect(copy.title).toBe(original.title);
      expect(copy.statement).toBe(original.statement);
      expect(copy.type).toBe(original.type);
      expect(copy.priority).toBe(original.priority);
      expect(copy.status).toBe(original.status);
      expect(copy.rationale).toBe(original.rationale);
      expect(copy.acceptance).toBe(original.acceptance);
      // Provenance is preserved on create; `updatedAt` is deliberately local and is not.
      expect(copy.createdAt.toISOString()).toBe(original.createdAt.toISOString());
      // The parent, resolved through both sets of ids.
      expect(copy.parentId === null ? null : reqNumberById.get(copy.parentId)).toBe(
        original.parentId === null ? null : sourceReqNumberById.get(original.parentId)
      );
    }

    // Said explicitly, because "every field survived" would still be true of a flat list if
    // all four parents happened to be null.
    const byNumber = new Map(imported.map((row) => [row.reqNumber, row]));
    expect(byNumber.get('REQ-10001')!.parentId).toBeNull();
    expect(byNumber.get('REQ-10002')!.parentId).toBe(byNumber.get('REQ-10001')!.id);
    expect(byNumber.get('REQ-10003')!.parentId).toBe(byNumber.get('REQ-10002')!.id);
    expect(byNumber.get('REQ-10004')!.parentId).toBeNull();
  });

  it('re-exports the same bytes for the same rows, and the same content after a round trip', async () => {
    await seedTree();
    const first = await exportReqif();

    // Same data, exported twice: identifiers and the header timestamp are derived from the
    // rows, never from the clock or a random source.
    expect(await exportReqif()).toBe(first);

    await clearRequirements();
    expect((await importReqif(engineer, first)).status).toBe(200);
    const second = await exportReqif();

    /*
     * The two documents cannot be byte-identical, and neither could be expected to be: the
     * rows were deleted and recreated, so the row ids every IDENTIFIER is derived from are
     * new, and `updatedAt` is local and is deliberately not taken from the file. What must
     * match is everything that describes the requirements themselves, so the comparison
     * strips the identifiers and the timestamps.
     */
    const shape = (xml: string) =>
      xml
        .replace(/TPLM-[A-Z]+-[0-9a-f-]{36}/g, 'ID')
        .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'TIME');
    expect(shape(second)).toBe(shape(first));
  });

  it('serves the export as an XML attachment', async () => {
    await seedRequirement({ reqNumber: 'REQ-10001' });
    const res = await engineer.get(EXPORT_PATH);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/xml/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="requirements.reqif"');
    expect(res.text).toContain('http://www.omg.org/spec/ReqIF/20110401/reqif.xsd');
    expect(res.text).toContain('<REQ-IF-VERSION>1.0</REQ-IF-VERSION>');
  });

  it('exports an empty database as a valid, importable document', async () => {
    const xml = await exportReqif();
    const res = await importReqif(engineer, xml);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 0, updated: 0, skipped: 0 });
  });
});

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

describe('ReqIF enumerations', () => {
  it('maps every literal of every enum in both directions', async () => {
    /*
     * One requirement per literal of the longest enum, cycling the other two, so all five
     * types, all four priorities and all three statuses appear at least once in one document.
     * A mapping that read the EMBEDDED-VALUE ordinal instead of the LONG-NAME would survive a
     * single-value test and scramble everything here.
     */
    const types = Object.values(RequirementType);
    const priorities = Object.values(EcnPriority);
    const statuses = Object.values(RequirementStatus);
    for (const [index, type] of types.entries()) {
      await seedRequirement({
        reqNumber: `REQ-1000${index + 1}`,
        type,
        priority: priorities[index % priorities.length],
        status: statuses[index % statuses.length],
      });
    }

    const xml = await exportReqif();
    // Every literal is declared in the document by name, not merely by ordinal.
    for (const literal of [...types, ...priorities, ...statuses]) {
      expect(xml).toContain(`LONG-NAME="${literal}"`);
    }
    const source = await prisma.requirement.findMany({ orderBy: { reqNumber: 'asc' } });

    await clearRequirements();
    expect((await importReqif(engineer, xml)).status).toBe(200);

    const imported = await prisma.requirement.findMany({ orderBy: { reqNumber: 'asc' } });
    expect(imported.map((r) => [r.type, r.priority, r.status])).toEqual(
      source.map((r) => [r.type, r.priority, r.status])
    );
  });

  it('rejects an enum literal it does not have, naming the attribute and the value', async () => {
    await seedRequirement({ reqNumber: 'REQ-10001', type: RequirementType.SAFETY });
    const xml = (await exportReqif()).replace('LONG-NAME="SAFETY"', 'LONG-NAME="CATASTROPHIC"');

    const res = await importReqif(engineer, xml);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('TurboPLM.Type');
    expect(res.body.error).toContain('CATASTROPHIC');
  });
});

// ---------------------------------------------------------------------------
// Foreign documents
// ---------------------------------------------------------------------------

/**
 * A minimal document in the shape another tool produces: our three mappable attributes plus
 * attributes we have never heard of, on our own spec-object type.
 *
 * Written out by hand rather than generated from an export, because the point is precisely
 * to exercise the path where the file was NOT produced by this codebase.
 */
function foreignDocument(options: { extraAttributes: number; reqNumber?: string | null }): string {
  const extraDefs = Array.from(
    { length: options.extraAttributes },
    (_, i) => `
        <ATTRIBUTE-DEFINITION-STRING IDENTIFIER="doors-ad-${i}" LAST-CHANGE="2026-01-01T00:00:00.000Z" LONG-NAME="DOORS.Custom${i}">
          <TYPE><DATATYPE-DEFINITION-STRING-REF>dt-string</DATATYPE-DEFINITION-STRING-REF></TYPE>
        </ATTRIBUTE-DEFINITION-STRING>`
  ).join('');
  const extraValues = Array.from(
    { length: options.extraAttributes },
    (_, i) => `
            <ATTRIBUTE-VALUE-STRING THE-VALUE="dropped-${i}">
              <DEFINITION><ATTRIBUTE-DEFINITION-STRING-REF>doors-ad-${i}</ATTRIBUTE-DEFINITION-STRING-REF></DEFINITION>
            </ATTRIBUTE-VALUE-STRING>`
  ).join('');
  const foreignId =
    options.reqNumber === null
      ? ''
      : `
            <ATTRIBUTE-VALUE-STRING THE-VALUE="${options.reqNumber ?? 'REQ-20001'}">
              <DEFINITION><ATTRIBUTE-DEFINITION-STRING-REF>ad-foreign</ATTRIBUTE-DEFINITION-STRING-REF></DEFINITION>
            </ATTRIBUTE-VALUE-STRING>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<REQ-IF xmlns="http://www.omg.org/spec/ReqIF/20110401/reqif.xsd" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <THE-HEADER>
    <REQ-IF-HEADER IDENTIFIER="foreign-header">
      <CREATION-TIME>2026-01-01T00:00:00.000Z</CREATION-TIME>
      <REQ-IF-TOOL-ID>DOORS</REQ-IF-TOOL-ID>
      <REQ-IF-VERSION>1.0</REQ-IF-VERSION>
      <SOURCE-TOOL-ID>DOORS</SOURCE-TOOL-ID>
      <TITLE>Foreign module</TITLE>
    </REQ-IF-HEADER>
  </THE-HEADER>
  <CORE-CONTENT>
    <REQ-IF-CONTENT>
      <DATATYPES>
        <DATATYPE-DEFINITION-STRING IDENTIFIER="dt-string" LAST-CHANGE="2026-01-01T00:00:00.000Z" LONG-NAME="String" MAX-LENGTH="4000"/>
        <DATATYPE-DEFINITION-XHTML IDENTIFIER="dt-xhtml" LAST-CHANGE="2026-01-01T00:00:00.000Z" LONG-NAME="XHTML"/>
      </DATATYPES>
      <SPEC-TYPES>
        <SPEC-OBJECT-TYPE IDENTIFIER="foreign-sot" LAST-CHANGE="2026-01-01T00:00:00.000Z" LONG-NAME="Foreign requirement">
          <SPEC-ATTRIBUTES>
            <ATTRIBUTE-DEFINITION-STRING IDENTIFIER="ad-foreign" LAST-CHANGE="2026-01-01T00:00:00.000Z" LONG-NAME="ReqIF.ForeignID">
              <TYPE><DATATYPE-DEFINITION-STRING-REF>dt-string</DATATYPE-DEFINITION-STRING-REF></TYPE>
            </ATTRIBUTE-DEFINITION-STRING>
            <ATTRIBUTE-DEFINITION-STRING IDENTIFIER="ad-name" LAST-CHANGE="2026-01-01T00:00:00.000Z" LONG-NAME="ReqIF.Name">
              <TYPE><DATATYPE-DEFINITION-STRING-REF>dt-string</DATATYPE-DEFINITION-STRING-REF></TYPE>
            </ATTRIBUTE-DEFINITION-STRING>
            <ATTRIBUTE-DEFINITION-XHTML IDENTIFIER="ad-text" LAST-CHANGE="2026-01-01T00:00:00.000Z" LONG-NAME="ReqIF.Text">
              <TYPE><DATATYPE-DEFINITION-XHTML-REF>dt-xhtml</DATATYPE-DEFINITION-XHTML-REF></TYPE>
            </ATTRIBUTE-DEFINITION-XHTML>${extraDefs}
          </SPEC-ATTRIBUTES>
        </SPEC-OBJECT-TYPE>
        <SPECIFICATION-TYPE IDENTIFIER="foreign-st" LAST-CHANGE="2026-01-01T00:00:00.000Z" LONG-NAME="Foreign module"/>
      </SPEC-TYPES>
      <SPEC-OBJECTS>
        <SPEC-OBJECT IDENTIFIER="foreign-so-1" LAST-CHANGE="2026-01-01T00:00:00.000Z">
          <VALUES>${foreignId}
            <ATTRIBUTE-VALUE-STRING THE-VALUE="Imported from DOORS">
              <DEFINITION><ATTRIBUTE-DEFINITION-STRING-REF>ad-name</ATTRIBUTE-DEFINITION-STRING-REF></DEFINITION>
            </ATTRIBUTE-VALUE-STRING>
            <ATTRIBUTE-VALUE-XHTML>
              <DEFINITION><ATTRIBUTE-DEFINITION-XHTML-REF>ad-text</ATTRIBUTE-DEFINITION-XHTML-REF></DEFINITION>
              <THE-VALUE><xhtml:div>The unit <xhtml:b>shall</xhtml:b> respond within 10 ms.</xhtml:div></THE-VALUE>
            </ATTRIBUTE-VALUE-XHTML>${extraValues}
          </VALUES>
          <TYPE><SPEC-OBJECT-TYPE-REF>foreign-sot</SPEC-OBJECT-TYPE-REF></TYPE>
        </SPEC-OBJECT>
      </SPEC-OBJECTS>
      <SPECIFICATIONS>
        <SPECIFICATION IDENTIFIER="foreign-spec" LAST-CHANGE="2026-01-01T00:00:00.000Z" LONG-NAME="Foreign module">
          <TYPE><SPECIFICATION-TYPE-REF>foreign-st</SPECIFICATION-TYPE-REF></TYPE>
          <CHILDREN>
            <SPEC-HIERARCHY IDENTIFIER="foreign-sh-1" LAST-CHANGE="2026-01-01T00:00:00.000Z">
              <OBJECT><SPEC-OBJECT-REF>foreign-so-1</SPEC-OBJECT-REF></OBJECT>
            </SPEC-HIERARCHY>
          </CHILDREN>
        </SPECIFICATION>
      </SPECIFICATIONS>
    </REQ-IF-CONTENT>
  </CORE-CONTENT>
</REQ-IF>`;
}

describe('ReqIF import of a foreign document', () => {
  it('drops attributes it does not have, counts them, and imports the rest', async () => {
    const res = await importReqif(engineer, foreignDocument({ extraAttributes: 5 }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      created: 1,
      updated: 0,
      skipped: 0,
      unknownAttributesDropped: 5,
    });

    const imported = await prisma.requirement.findUniqueOrThrow({
      where: { reqNumber: 'REQ-20001' },
    });
    expect(imported.title).toBe('Imported from DOORS');
    // The XHTML statement is flattened to the plain text our column holds, with the inline
    // markup removed and the words still separated.
    expect(imported.statement).toBe('The unit shall respond within 10 ms.');
    // Nothing the file failed to state is invented: the column defaults apply.
    expect(imported.type).toBe(RequirementType.FUNCTIONAL);
    expect(imported.priority).toBe(EcnPriority.MEDIUM);
    expect(imported.status).toBe(RequirementStatus.DRAFT);
  });

  it('skips a SPEC-OBJECT with no ReqIF.ForeignID rather than inventing a number', async () => {
    const res = await importReqif(
      engineer,
      foreignDocument({ extraAttributes: 0, reqNumber: null })
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 0, updated: 0, skipped: 1 });
    expect(await prisma.requirement.count()).toBe(0);
  });

  it('keeps auto-numbering working after importing generated-format numbers', async () => {
    /*
     * Rule R1 allocates by scanning MAX() over the reqNumbers that exist, so a number that
     * arrived from a file is visible to the next allocation with nothing reserved. Asserted
     * anyway, because that is a property of how the generator happens to be written: an
     * import that reached the numbering some other way would leave the next POST colliding on
     * the unique index until it exhausted its retries.
     */
    const doc = foreignDocument({ extraAttributes: 0, reqNumber: 'REQ-10007' });
    expect((await importReqif(engineer, doc)).status).toBe(200);

    const created = await engineer.post('/api/requirements', {
      title: 'Created after the import',
      statement: 'Must not collide with an imported number.',
    });
    expect(created.status).toBe(201);
    expect(created.body.reqNumber).toBe('REQ-10008');
  });
});

// ---------------------------------------------------------------------------
// Refusals — and the promise that a refusal writes nothing
// ---------------------------------------------------------------------------

describe('ReqIF import refusals', () => {
  /** Every case below asserts this: the table is exactly as it was. */
  async function snapshot() {
    return prisma.requirement.findMany({
      orderBy: { reqNumber: 'asc' },
      select: { reqNumber: true, title: true, statement: true, status: true, parentId: true },
    });
  }

  it('imports nothing when the file is not well-formed XML', async () => {
    await seedRequirement({ reqNumber: 'REQ-10001' });
    const before = await snapshot();

    const truncated = (await exportReqif()).slice(0, 2000);
    const res = await importReqif(engineer, truncated);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not well-formed XML/);
    expect(await snapshot()).toEqual(before);
  });

  it('imports nothing when one requirement deep in the file is invalid', async () => {
    /*
     * The sharpest form of "import nothing unless the whole file parses": the file is
     * perfectly good up to its LAST requirement, so an importer that wrote as it parsed would
     * leave the first two behind and report an error.
     */
    for (const number of ['REQ-10001', 'REQ-10002', 'REQ-10003']) {
      await seedRequirement({ reqNumber: number });
    }

    // Break the THIRD SPEC-OBJECT only: everything before it is valid.
    const objects = (await exportReqif()).split('<SPEC-OBJECT ');
    expect(objects).toHaveLength(4); // the prefix plus three requirements
    objects[3] = objects[3].replace('<ENUM-VALUE-REF>', '<ENUM-VALUE-REF>no-such-');
    const broken = objects.join('<SPEC-OBJECT ');

    // Imported into an empty table, so "created nothing" is the whole claim and cannot be
    // satisfied by rows that were already there.
    await clearRequirements();
    const res = await importReqif(engineer, broken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not define/);
    expect(await prisma.requirement.count()).toBe(0);
  });

  it('rejects a file whose root element is not REQ-IF', async () => {
    const res = await importReqif(engineer, '<?xml version="1.0"?><catalog><item/></catalog>');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a ReqIF document/i);
  });

  it('rejects a DOCTYPE declaration outright', async () => {
    const xml = (await exportReqif()).replace(
      '<REQ-IF ',
      '<!DOCTYPE REQ-IF [<!ENTITY xxe "expanded">]>\n<REQ-IF '
    );
    const res = await importReqif(engineer, xml);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/DOCTYPE/);
  });

  it('rejects a UTF-16 document rather than reading it as mojibake', async () => {
    await seedRequirement({ reqNumber: 'REQ-10001' });
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(await exportReqif(), 'utf16le'),
    ]);
    const res = await engineer.post(IMPORT_PATH).attach('file', utf16, 'requirements.reqif');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/UTF-16/);
  });

  it('rejects a file that names the same requirement twice', async () => {
    await seedRequirement({ reqNumber: 'REQ-10001' });
    await seedRequirement({ reqNumber: 'REQ-10002' });
    const before = await snapshot();

    const xml = (await exportReqif()).replace('THE-VALUE="REQ-10002"', 'THE-VALUE="REQ-10001"');
    const res = await importReqif(engineer, xml);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/appears twice/);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects an empty upload and a missing file', async () => {
    expect((await importReqif(engineer, '   ')).status).toBe(400);
    const noFile = await engineer.post(IMPORT_PATH);
    expect(noFile.status).toBe(400);
    expect(noFile.body.error).toMatch(/file is required/);
  });

  it('refuses an import that would close a cycle against a frozen requirement', async () => {
    /*
     * The only way a cycle can arise, and worth stating because it is not obvious.
     *
     * SPEC-HIERARCHY nesting is a tree, so the parentage a file asks for is always a forest;
     * and every parent it names is itself in the file. If the import rewrote every row the
     * file mentions, the result could not contain a loop. A cycle therefore needs a row the
     * file mentions but the import does NOT rewrite — which is exactly a requirement frozen
     * by rule R3.
     *
     * Here REQ-10001 is APPROVED with REQ-10002 as its parent. The file says the reverse.
     * REQ-10001 is skipped and keeps its parent; REQ-10002 is a draft and takes the file's.
     * The two edges close the loop, and neither request could see it alone.
     */

    // The document, built by exporting the exact inversion and then clearing it away.
    const inverted = await seedRequirement({ reqNumber: 'REQ-10001' });
    await seedRequirement({ reqNumber: 'REQ-10002', parentId: inverted.id });
    const xml = await exportReqif();
    await clearRequirements();

    const draft = await seedRequirement({ reqNumber: 'REQ-10002' });
    await seedRequirement({
      reqNumber: 'REQ-10001',
      parentId: draft.id,
      status: RequirementStatus.APPROVED,
    });
    const before = await snapshot();

    const res = await importReqif(engineer, xml);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cycle/i);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a VIEWER', async () => {
    const viewer = await createAndLogin({ role: Role.VIEWER });
    const res = await importReqif(viewer, foreignDocument({ extraAttributes: 0 }));
    expect(res.status).toBe(403);
    expect(await prisma.requirement.count()).toBe(0);
  });

  it('lets a VIEWER export', async () => {
    await seedRequirement({ reqNumber: 'REQ-10001' });
    const viewer = await createAndLogin({ role: Role.VIEWER });
    expect((await viewer.get(EXPORT_PATH)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Matching, not duplicating
// ---------------------------------------------------------------------------

describe('ReqIF import matching', () => {
  it('updates on a second import instead of duplicating', async () => {
    await seedRequirement({ reqNumber: 'REQ-10001', title: 'Original title' });
    await seedRequirement({ reqNumber: 'REQ-10002' });
    const xml = await exportReqif();

    await clearRequirements();
    const first = await importReqif(engineer, xml);
    expect(first.body).toMatchObject({ created: 2, updated: 0 });

    const second = await importReqif(engineer, xml);
    expect(second.body).toMatchObject({ created: 0, updated: 2 });
    expect(await prisma.requirement.count()).toBe(2);

    // And an edit really does travel in the file: the title is revised, exported, rolled
    // back locally, and put right again by the import rather than by the local edit.
    await prisma.requirement.update({
      where: { reqNumber: 'REQ-10001' },
      data: { title: 'Revised title' },
    });
    const revisedXml = await exportReqif();
    await prisma.requirement.update({
      where: { reqNumber: 'REQ-10001' },
      data: { title: 'Original title' },
    });

    const third = await importReqif(engineer, revisedXml);
    expect(third.body).toMatchObject({ created: 0, updated: 2 });
    const revised = await prisma.requirement.findFirstOrThrow({
      where: { reqNumber: 'REQ-10001' },
    });
    expect(revised.title).toBe('Revised title');
  });

  it('leaves a requirement that is not DRAFT untouched and counts it as skipped', async () => {
    /*
     * Rule R3 — an APPROVED requirement is frozen, and PATCH refuses to touch one. An import
     * must not be the way around change control, so the row is skipped and the rest of the
     * file still lands.
     */
    await seedRequirement({ reqNumber: 'REQ-10001', title: 'Rewritten by the import' });
    await seedRequirement({ reqNumber: 'REQ-10002', title: 'Also rewritten' });
    const xml = await exportReqif();
    await clearRequirements();

    await seedRequirement({
      reqNumber: 'REQ-10001',
      title: 'Approved and frozen',
      status: RequirementStatus.APPROVED,
    });
    await seedRequirement({ reqNumber: 'REQ-10002', title: 'Still a draft' });

    const res = await importReqif(engineer, xml);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 0, updated: 1, skipped: 1 });

    const frozen = await prisma.requirement.findFirstOrThrow({ where: { reqNumber: 'REQ-10001' } });
    expect(frozen.title).toBe('Approved and frozen');
    expect(frozen.status).toBe(RequirementStatus.APPROVED);
    const draft = await prisma.requirement.findFirstOrThrow({ where: { reqNumber: 'REQ-10002' } });
    expect(draft.title).toBe('Also rewritten');
  });
});

// ---------------------------------------------------------------------------
// Item-level access control on the export
// ---------------------------------------------------------------------------

describe('ReqIF export and item-level ACLs', () => {
  it('redacts the identity of a linked part the caller may not read', async () => {
    const insider = await createAndLogin({ role: Role.ENGINEER });
    const outsider = await createAndLogin({ role: Role.ENGINEER });

    const openPart = await prisma.part.create({
      data: {
        partNumber: 'P-OPEN-1',
        name: 'Open part',
        category: PartCategory.MECHANICAL,
        createdById: insider.id,
      },
    });
    const secretPart = await prisma.part.create({
      data: {
        partNumber: 'P-SECRET-1',
        name: 'Secret part',
        category: PartCategory.MECHANICAL,
        createdById: insider.id,
      },
    });
    // The first grant is what closes the item (rule X1); the outsider now cannot read it.
    await prisma.partAcl.create({
      data: {
        partId: secretPart.id,
        userId: insider.id,
        permission: AclPermission.READ,
        grantedById: insider.id,
      },
    });

    const requirement = await seedRequirement({ reqNumber: 'REQ-10001' });
    await prisma.requirementLink.createMany({
      data: [
        { requirementId: requirement.id, partId: openPart.id },
        { requirementId: requirement.id, partId: secretPart.id },
      ],
    });

    const insiderXml = await exportReqif(insider);
    expect(insiderXml).toContain('PART:P-OPEN-1');
    expect(insiderXml).toContain('PART:P-SECRET-1');

    const outsiderXml = await exportReqif(outsider);
    expect(outsiderXml).toContain('PART:P-OPEN-1');
    // The link is still there — the count is not sensitive — but the part number is gone.
    expect(outsiderXml).not.toContain('P-SECRET-1');
    expect(outsiderXml).toContain('PART:Restricted');
  });

  it('counts the links extension as ignored rather than applying it', async () => {
    const part = await prisma.part.create({
      data: {
        partNumber: 'P-LINKED-1',
        name: 'Linked part',
        category: PartCategory.MECHANICAL,
        createdById: engineer.id,
      },
    });
    const document = await prisma.document.create({
      data: { docNumber: 'DOC-10001', title: 'Test procedure', createdById: engineer.id },
    });
    const requirement = await seedRequirement({ reqNumber: 'REQ-10001' });
    await prisma.requirementLink.createMany({
      data: [
        { requirementId: requirement.id, partId: part.id },
        { requirementId: requirement.id, documentId: document.id },
      ],
    });

    const xml = await exportReqif();
    expect(xml).toContain('PART:P-LINKED-1; DOCUMENT:DOC-10001');
    // Individual links, not requirements carrying links: one requirement, two dropped links.
    expect(parseReqifDocument(xml).linksIgnored).toBe(2);

    // Everything the file names is cleared away first, so "the import made no link" cannot be
    // satisfied by rows that survived it.
    await clearRequirements();
    await prisma.document.deleteMany();
    await prisma.part.deleteMany();

    const res = await importReqif(engineer, xml);
    expect(res.status).toBe(200);
    expect(res.body.linksIgnored).toBe(2);
    // A part number out of a file names nothing here, so no link is made and — crucially —
    // no part is invented to hang it on.
    expect(await prisma.requirementLink.count()).toBe(0);
    expect(await prisma.part.count()).toBe(0);
    expect(await prisma.document.count()).toBe(0);
  });
});
