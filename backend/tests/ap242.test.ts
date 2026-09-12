/**
 * AP242 product-structure export — GET /api/revisions/:id/export/step.
 *
 * The assertions here are chosen for the failures that would ship silently. A malformed
 * header is caught by the first importer that opens the file; a quantity that quietly
 * became 1, a part number whose apostrophe truncated the string, or a restricted part
 * that walked out through the export are not — they look like a working file right up to
 * the point where somebody builds the wrong assembly or reads a competitor's BOM.
 *
 * Rules covered: 5 (resolved revision — the export must show what the screen shows), X4
 * (a hidden child is redacted, never omitted, so the structure still adds up) and X5 (an
 * export applies the same filter and redaction as the screen it mirrors).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Lifecycle, PartCategory, Role } from '@prisma/client';
import { Client, createAndLogin } from './helpers/api';
import { prisma } from './helpers/db';
import { addBomLine, addRevision, createPart, createReleasedPart } from './helpers/factories';

let engineer: Client;

beforeEach(async () => {
  engineer = await createAndLogin();
});

/**
 * The response body as text.
 *
 * Superagent has no parser registered for `application/step`, so it buffers the body
 * instead of decoding it. Reading it here rather than changing the route's content type
 * keeps the test honest about what the endpoint actually sends.
 */
function stepText(res: { text?: string; body: unknown }): string {
  if (typeof res.text === 'string' && res.text.length > 0) return res.text;
  return Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body);
}

async function exportStep(client: Client, revisionId: number): Promise<string> {
  const res = await client.get(`/api/revisions/${revisionId}/export/step`);
  expect(res.status).toBe(200);
  return stepText(res);
}

/** Occurrences of a fixed substring — NAUO counting, mostly. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Just the entity instances.
 *
 * The DATA-section comment names entity types in prose ("...carried on
 * QUANTIFIED_ASSEMBLY_COMPONENT_USAGE complexed with NEXT_ASSEMBLY_USAGE_OCCURRENCE..."),
 * so counting occurrences over the whole file counts the explanation as well as the data.
 */
function entities(text: string): string {
  return text.slice(text.indexOf('*/') + 2);
}

describe('Part 21 envelope', () => {
  it('emits the ISO-10303-21 envelope and the AP242 schema line', async () => {
    const part = await createPart({ createdById: engineer.id, partNumber: 'ENV-1000' });
    const text = await exportStep(engineer, part.revisionId);

    expect(text.startsWith('ISO-10303-21;\n')).toBe(true);
    expect(text.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);
    expect(text).toContain(
      "FILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 3 1 4 }'));"
    );
    // The section markers, in order, exactly once each.
    expect(text.indexOf('HEADER;')).toBeLessThan(text.indexOf('DATA;'));
    expect(occurrences(text, '\nENDSEC;\n')).toBe(2);
    expect(text).toMatch(/FILE_DESCRIPTION\(\(.*\),'2;1'\);/);
    expect(text).toContain(",(''),(''),'TurboPLM','','');");
  });

  it('says in the file that it carries no geometry', async () => {
    const part = await createPart({ createdById: engineer.id, partNumber: 'ENV-1001' });
    const text = await exportStep(engineer, part.revisionId);

    // Once in FILE_DESCRIPTION, where a reader looks, and once in the DATA comment.
    expect(occurrences(text, 'NO GEOMETRY')).toBe(2);
    const header = text.slice(0, text.indexOf('DATA;'));
    expect(header).toContain('PRODUCT STRUCTURE ONLY - NO GEOMETRY');
    // Nothing that would let a reader believe there is shape data here.
    expect(text).not.toContain('ADVANCED_BREP_SHAPE_REPRESENTATION');
    expect(text).not.toContain('SHAPE_DEFINITION_REPRESENTATION');
  });

  it('sends it as an attachment named after the part and revision', async () => {
    const part = await createPart({ createdById: engineer.id, partNumber: 'ENV-1002' });
    const res = await engineer.get(`/api/revisions/${part.revisionId}/export/step`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/step/);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="ENV-1002_revA.stp"'
    );
    expect(stepText(res)).toContain("FILE_NAME('ENV-1002_revA.stp'");
  });

  it('answers 404 for a revision that does not exist', async () => {
    const res = await engineer.get('/api/revisions/999999/export/step');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Revision not found');
  });
});

describe('the PDM entity graph', () => {
  it('emits one product, formation, definition and category per part', async () => {
    const part = await createPart({
      createdById: engineer.id,
      partNumber: 'GRAPH-1000',
      name: 'Frame weldment',
      category: PartCategory.ASSEMBLY,
    });
    await prisma.part.update({
      where: { id: part.id },
      data: { description: 'Welded steel frame' },
    });
    await prisma.partRevision.update({
      where: { id: part.revisionId },
      data: { changeNote: 'Widened the bracket' },
    });

    const text = await exportStep(engineer, part.revisionId);

    expect(text).toContain('APPLICATION_CONTEXT(');
    expect(text).toContain('APPLICATION_PROTOCOL_DEFINITION(');
    expect(text).toMatch(
      /#\d+=PRODUCT\('GRAPH-1000','Frame weldment','Welded steel frame',\(#\d+\)\);/
    );
    expect(text).toMatch(/#\d+=PRODUCT_DEFINITION_FORMATION\('A','Widened the bracket',#\d+\);/);
    // The lifecycle state travels as the product definition's id.
    expect(text).toMatch(/#\d+=PRODUCT_DEFINITION\('IN_WORK',\$,#\d+,#\d+\);/);
    /*
     * Classification is 'part' first, with our own category beneath it.
     *
     * PDM Schema Usage Guide r4.3 §1.1.3 makes PRODUCT_RELATED_PRODUCT_CATEGORY the mechanism
     * that tells a receiving system a product is a PART rather than a DOCUMENT, and tells
     * postprocessors to expect the name 'part'. An earlier version emitted only our raw enum —
     * 'ASSEMBLY', 'MECHANICAL' — which is outside that vocabulary, so an importer found nothing
     * in the file it recognised as a part at all.
     */
    expect(text).toMatch(/#\d+=PRODUCT_RELATED_PRODUCT_CATEGORY\('part',\$,\((?:#\d+,?)+\)\);/);
    expect(text).toMatch(/#\d+=PRODUCT_RELATED_PRODUCT_CATEGORY\('assembly',\$,\((?:#\d+,?)+\)\);/);
    expect(text).toMatch(/#\d+=PRODUCT_CATEGORY_RELATIONSHIP\('sub-category',/);
    // Nothing to relate: a single part carries no assembly usage.
    expect(occurrences(entities(text), 'NEXT_ASSEMBLY_USAGE_OCCURRENCE')).toBe(0);
  });

  it('writes $ for an absent description rather than an empty string', async () => {
    const part = await createPart({ createdById: engineer.id, partNumber: 'GRAPH-1001' });
    const text = await exportStep(engineer, part.revisionId);

    expect(text).toMatch(/#\d+=PRODUCT\('GRAPH-1001',[^;]*,\$,\(#\d+\)\);/);
  });

  it('numbers every entity and leaves no dangling reference', async () => {
    const top = await createPart({ createdById: engineer.id, partNumber: 'GRAPH-2000' });
    const child = await createReleasedPart({
      createdById: engineer.id,
      partNumber: 'GRAPH-2001',
    });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: child.id, quantity: 2 });

    const text = await exportStep(engineer, top.revisionId);
    const declared = new Set(
      [...text.matchAll(/^#(\d+)=/gm)].map((match) => Number(match[1]))
    );
    const referenced = [...text.matchAll(/[(,]#(\d+)/g)].map((match) => Number(match[1]));

    expect(declared.size).toBeGreaterThan(0);
    // Ids are 1..N with no gaps, so the file is diffable line by line.
    expect([...declared].sort((a, b) => a - b)).toEqual(
      Array.from({ length: declared.size }, (_, i) => i + 1)
    );
    for (const ref of referenced) expect(declared.has(ref)).toBe(true);
  });
});

describe('assembly structure', () => {
  /** TOP -> SUB -> LEAF, which is two positions and therefore two NAUOs. */
  async function twoLevelAssembly() {
    const top = await createPart({
      createdById: engineer.id,
      partNumber: 'ASM-TOP',
      category: PartCategory.ASSEMBLY,
    });
    const sub = await createReleasedPart({
      createdById: engineer.id,
      partNumber: 'ASM-SUB',
      category: PartCategory.ASSEMBLY,
    });
    const leaf = await createReleasedPart({ createdById: engineer.id, partNumber: 'ASM-LEAF' });
    await addBomLine({
      parentRevisionId: top.revisionId,
      childPartId: sub.id,
      findNumber: 10,
      quantity: 2,
    });
    await addBomLine({
      parentRevisionId: sub.revisionId,
      childPartId: leaf.id,
      findNumber: 20,
      quantity: 3,
    });
    return { top, sub, leaf };
  }

  it('emits one NAUO per BOM position across two levels', async () => {
    const { top } = await twoLevelAssembly();
    const text = await exportStep(engineer, top.revisionId);

    expect(occurrences(entities(text), 'NEXT_ASSEMBLY_USAGE_OCCURRENCE()')).toBe(2);
    expect(occurrences(entities(text), 'QUANTIFIED_ASSEMBLY_COMPONENT_USAGE(')).toBe(2);
    // Three parts reached, so three products.
    expect(occurrences(entities(text), '=PRODUCT(')).toBe(3);
    expect(text).toContain("'ASM-TOP'");
    expect(text).toContain("'ASM-SUB'");
    expect(text).toContain("'ASM-LEAF'");
  });

  it('resolves each child to its latest RELEASED revision, as the BOM read does', async () => {
    const top = await createPart({ createdById: engineer.id, partNumber: 'RES-TOP' });
    const child = await createReleasedPart({ createdById: engineer.id, partNumber: 'RES-CHILD' });
    // A later revision that is NOT released must not win over the released one.
    await addRevision({
      partId: child.id,
      createdById: engineer.id,
      revision: 'B',
      lifecycle: Lifecycle.IN_WORK,
    });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: child.id });

    const text = await exportStep(engineer, top.revisionId);
    expect(text).toMatch(/PRODUCT_DEFINITION_FORMATION\('A',\$,#\d+\);/);
    expect(text).not.toContain("PRODUCT_DEFINITION_FORMATION('B'");
    expect(occurrences(entities(text), "PRODUCT_DEFINITION('RELEASED'")).toBe(1);
  });

  it('exports the root at the revision asked for, released or not', async () => {
    const part = await createPart({ createdById: engineer.id, partNumber: 'ROOT-1000' });
    const later = await addRevision({
      partId: part.id,
      createdById: engineer.id,
      revision: 'B',
      lifecycle: Lifecycle.RELEASED,
    });

    const text = await exportStep(engineer, part.revisionId);
    expect(text).toMatch(/PRODUCT_DEFINITION_FORMATION\('A',/);
    expect(text).not.toContain("PRODUCT_DEFINITION_FORMATION('B'");
    expect(later.revision).toBe('B');
  });

  it('emits a shared subassembly once but keeps both positions', async () => {
    const top = await createPart({ createdById: engineer.id, partNumber: 'SHARE-TOP' });
    const branchA = await createReleasedPart({ createdById: engineer.id, partNumber: 'SHARE-A' });
    const branchB = await createReleasedPart({ createdById: engineer.id, partNumber: 'SHARE-B' });
    const common = await createReleasedPart({ createdById: engineer.id, partNumber: 'SHARE-C' });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: branchA.id });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: branchB.id });
    await addBomLine({ parentRevisionId: branchA.revisionId, childPartId: common.id });
    await addBomLine({ parentRevisionId: branchB.revisionId, childPartId: common.id });

    const text = await exportStep(engineer, top.revisionId);
    expect(occurrences(entities(text), "=PRODUCT('SHARE-C'")).toBe(1);
    expect(occurrences(entities(text), 'NEXT_ASSEMBLY_USAGE_OCCURRENCE()')).toBe(4);
  });

  it('terminates on a cycle instead of hanging, and says so in the file', async () => {
    // The API refuses to create this; the exporter must survive finding one anyway, so
    // the rows go in directly.
    const a = await createReleasedPart({ createdById: engineer.id, partNumber: 'CYC-A' });
    const b = await createReleasedPart({ createdById: engineer.id, partNumber: 'CYC-B' });
    await addBomLine({ parentRevisionId: a.revisionId, childPartId: b.id });
    await addBomLine({ parentRevisionId: b.revisionId, childPartId: a.id });

    const text = await exportStep(engineer, a.revisionId);
    expect(occurrences(entities(text), 'NEXT_ASSEMBLY_USAGE_OCCURRENCE()')).toBe(2);
    expect(text).toContain('CYC-A appears within its own assembly');
  });
});

describe('quantity', () => {
  it('carries the quantity on a measure, not in the usage id or reference designator', async () => {
    const top = await createPart({ createdById: engineer.id, partNumber: 'QTY-TOP' });
    const child = await createReleasedPart({ createdById: engineer.id, partNumber: 'QTY-CHILD' });
    await addBomLine({
      parentRevisionId: top.revisionId,
      childPartId: child.id,
      findNumber: 30,
      quantity: 4,
      uom: 'ea',
    });

    const text = await exportStep(engineer, top.revisionId);

    // The measure, its unit, and the complex instance that binds it to the usage.
    expect(text).toMatch(/#\d+=CONTEXT_DEPENDENT_UNIT\(#\d+,'ea'\);/);
    expect(text).toMatch(/#\d+=MEASURE_WITH_UNIT\(CONTEXT_DEPENDENT_MEASURE\(4\.\),#\d+\);/);
    // The partial records of the complex instance, in the alphabetical order Part 21
    // requires — a reader that cannot match them rejects the whole instance.
    expect(entities(text)).toContain(
      '(ASSEMBLY_COMPONENT_USAGE($)NEXT_ASSEMBLY_USAGE_OCCURRENCE()' +
        "PRODUCT_DEFINITION_RELATIONSHIP('30','',$,"
    );
    expect(entities(text)).toMatch(
      /PRODUCT_DEFINITION_USAGE\(\)QUANTIFIED_ASSEMBLY_COMPONENT_USAGE\(#\d+\)\);/
    );
    // The usage id is the find number. If the quantity were smuggled in there instead,
    // an importer would read '4' as an item number and instantiate the child once.
    expect(text).not.toContain("PRODUCT_DEFINITION_RELATIONSHIP('4',");
  });

  it('writes a fractional quantity as a Part 21 real', async () => {
    const top = await createPart({ createdById: engineer.id, partNumber: 'QTY-FRAC' });
    const wire = await createReleasedPart({ createdById: engineer.id, partNumber: 'QTY-WIRE' });
    await addBomLine({
      parentRevisionId: top.revisionId,
      childPartId: wire.id,
      quantity: 2.5,
      uom: 'm',
    });

    const text = await exportStep(engineer, top.revisionId);
    expect(text).toContain('CONTEXT_DEPENDENT_MEASURE(2.5)');
    expect(text).toMatch(/CONTEXT_DEPENDENT_UNIT\(#\d+,'m'\);/);
  });

  it('emits one unit entity per distinct unit of measure', async () => {
    const top = await createPart({ createdById: engineer.id, partNumber: 'QTY-UNITS' });
    const first = await createReleasedPart({ createdById: engineer.id, partNumber: 'QTY-U1' });
    const second = await createReleasedPart({ createdById: engineer.id, partNumber: 'QTY-U2' });
    const third = await createReleasedPart({ createdById: engineer.id, partNumber: 'QTY-U3' });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: first.id, uom: 'ea' });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: second.id, uom: 'ea' });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: third.id, uom: 'kg' });

    const text = await exportStep(engineer, top.revisionId);
    expect(occurrences(entities(text), '=CONTEXT_DEPENDENT_UNIT(')).toBe(2);
    expect(occurrences(entities(text), '=MEASURE_WITH_UNIT(')).toBe(3);
  });

  it('keeps the reference designator list out of the single-label slot', async () => {
    const top = await createPart({ createdById: engineer.id, partNumber: 'REF-TOP' });
    const child = await createReleasedPart({ createdById: engineer.id, partNumber: 'REF-CHILD' });
    await addBomLine({
      parentRevisionId: top.revisionId,
      childPartId: child.id,
      findNumber: 40,
      refDesignators: 'R1,R2,R5',
    });

    const text = await exportStep(engineer, top.revisionId);
    // reference_designator holds one label; the verbatim list travels as the usage name.
    expect(text).toContain('ASSEMBLY_COMPONENT_USAGE($)');
    expect(text).toContain("PRODUCT_DEFINITION_RELATIONSHIP('40','R1,R2,R5',$,");
  });
});

describe('Part 21 string escaping', () => {
  it('doubles an apostrophe in a part number and keeps the file readable', async () => {
    const part = await createPart({
      createdById: engineer.id,
      partNumber: "BRKT-O'NEILL",
      name: "Dave's bracket",
    });
    const text = await exportStep(engineer, part.revisionId);

    expect(text).toContain("PRODUCT('BRKT-O''NEILL','Dave''s bracket',");
    // The unescaped form must appear nowhere: a single quote would close the literal and
    // shift every following attribute by one.
    expect(text).not.toContain("BRKT-O'NEILL");
    expect(text).not.toContain("Dave's");
  });

  it('escapes a backslash by doubling it', async () => {
    const part = await createPart({
      createdById: engineer.id,
      partNumber: 'ESC-BACKSLASH',
      name: 'Left\\Right',
    });
    const text = await exportStep(engineer, part.revisionId);
    expect(text).toContain("'Left\\\\Right'");
  });

  it('encodes non-ASCII with the \\X2\\ control directive, one run at a time', async () => {
    const part = await createPart({
      createdById: engineer.id,
      partNumber: 'ESC-UNICODE',
      // Ø is U+00D8 and ß is U+00DF: adjacent, so they share ONE directive rather than
      // opening and closing one each. µ is U+00B5, on its own further along.
      name: 'Øß pin, 50µm',
    });
    const text = await exportStep(engineer, part.revisionId);

    expect(text).toContain("'\\X2\\00D800DF\\X0\\ pin, 50\\X2\\00B5\\X0\\m'");
    // The whole file stays 7-bit, which is what makes the content type unambiguous.
    expect(/^[\t\n\r\x20-\x7e]*$/.test(text)).toBe(true);
  });

  it('cannot have a part number close the DATA-section comment', async () => {
    const top = await createPart({ createdById: engineer.id, partNumber: 'CMT-TOP' });
    // A part number that ends a Part 21 comment, reached through a note-producing path.
    const child = await createPart({ createdById: engineer.id, partNumber: 'CMT-*/-CHILD' });
    await prisma.partRevision.deleteMany({ where: { partId: child.id } });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: child.id });

    const text = await exportStep(engineer, top.revisionId);
    const comment = text.slice(text.indexOf('/*'), text.indexOf('*/') + 2);
    expect(comment).toContain('CMT-* /-CHILD');
    // Exactly one comment: the neutralised part number did not open a second one.
    expect(occurrences(text, '/*')).toBe(1);
    expect(occurrences(text, '*/')).toBe(1);
    // The position could not be represented, and the file says so rather than dropping it
    // in silence.
    expect(comment).toContain('has no revision');
    expect(occurrences(entities(text), 'NEXT_ASSEMBLY_USAGE_OCCURRENCE()')).toBe(0);
  });
});

describe('determinism', () => {
  it('produces byte-identical output for two exports of unchanged data', async () => {
    const top = await createPart({ createdById: engineer.id, partNumber: 'DET-TOP' });
    const sub = await createReleasedPart({ createdById: engineer.id, partNumber: 'DET-SUB' });
    const leafOne = await createReleasedPart({ createdById: engineer.id, partNumber: 'DET-L1' });
    const leafTwo = await createReleasedPart({ createdById: engineer.id, partNumber: 'DET-L2' });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: sub.id, findNumber: 10 });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: leafTwo.id, findNumber: 20 });
    await addBomLine({ parentRevisionId: sub.revisionId, childPartId: leafOne.id, findNumber: 30 });

    const first = await exportStep(engineer, top.revisionId);
    const second = await exportStep(engineer, top.revisionId);
    expect(second).toBe(first);

    // Including the time stamp, which is derived from the data rather than the clock —
    // the property the byte-identity depends on.
    expect(first).toMatch(/FILE_NAME\('DET-TOP_revA\.stp','\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ'/);
  });

  it('emits parts in walk order, so parents precede their components', async () => {
    const top = await createPart({ createdById: engineer.id, partNumber: 'ORD-TOP' });
    // Deliberately reverse-alphabetical against find-number order: if the exporter sorted
    // by part number instead of walking, these would come out the other way round.
    const first = await createReleasedPart({ createdById: engineer.id, partNumber: 'ORD-ZULU' });
    const second = await createReleasedPart({ createdById: engineer.id, partNumber: 'ORD-ALFA' });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: first.id, findNumber: 10 });
    await addBomLine({ parentRevisionId: top.revisionId, childPartId: second.id, findNumber: 20 });

    const text = await exportStep(engineer, top.revisionId);
    expect(text.indexOf("'ORD-TOP'")).toBeLessThan(text.indexOf("'ORD-ZULU'"));
    expect(text.indexOf("'ORD-ZULU'")).toBeLessThan(text.indexOf("'ORD-ALFA'"));
  });
});

describe('rules X4/X5 — item-level access control', () => {
  /**
   * A two-level assembly whose middle component is restricted to `insider` alone.
   * `outsider` is an ENGINEER, so nothing but the item-level grant separates them.
   */
  async function restrictedWorld() {
    const insider = await createAndLogin({ role: Role.ENGINEER });
    const outsider = await createAndLogin({ role: Role.ENGINEER });

    const top = await createPart({ createdById: insider.id, partNumber: 'ACL-TOP' });
    const secret = await createReleasedPart({
      createdById: insider.id,
      partNumber: 'ACL-SECRET',
      name: 'Classified actuator',
    });
    const open = await createReleasedPart({ createdById: insider.id, partNumber: 'ACL-OPEN' });
    const buried = await createReleasedPart({
      createdById: insider.id,
      partNumber: 'ACL-BURIED',
      name: 'Buried under the secret',
    });
    await addBomLine({
      parentRevisionId: top.revisionId,
      childPartId: secret.id,
      findNumber: 10,
      quantity: 7,
    });
    await addBomLine({
      parentRevisionId: top.revisionId,
      childPartId: open.id,
      findNumber: 20,
    });
    await addBomLine({ parentRevisionId: secret.revisionId, childPartId: buried.id });

    await prisma.partAcl.create({
      data: { partId: secret.id, userId: insider.id, grantedById: insider.id },
    });
    return { insider, outsider, top, secret, open, buried };
  }

  it('does not export a restricted part to someone who cannot read it', async () => {
    const world = await restrictedWorld();
    const text = await exportStep(world.outsider, world.top.revisionId);

    expect(text).not.toContain('ACL-SECRET');
    expect(text).not.toContain('Classified actuator');
    // Nor anything reachable only through it — an unexpandable branch discloses its shape.
    expect(text).not.toContain('ACL-BURIED');
    expect(text).not.toContain('Buried under the secret');
    // Nor the hidden part's revision label, lifecycle state or category. Only ACL-OPEN is
    // released as far as this caller can tell; the hidden part's state says RESTRICTED,
    // which discloses nothing, and it gets no category entity at all.
    expect(occurrences(entities(text), "PRODUCT_DEFINITION('RELEASED'")).toBe(1);
    expect(occurrences(entities(text), "PRODUCT_DEFINITION('RESTRICTED'")).toBe(1);
    /*
     * §2.1.1: "A given product category shall only be instantiated once in an exchange file."
     * Two parts sharing a category therefore produce ONE sub-category instance holding both,
     * plus the single 'part' instance above it — not one per product. The earlier one-per-part
     * emission meant a 500-part assembly wrote 500 instances over at most six distinct names.
     */
    expect(occurrences(entities(text), '=PRODUCT_RELATED_PRODUCT_CATEGORY(')).toBe(2);
    expect(occurrences(entities(text), '=PRODUCT_CATEGORY_RELATIONSHIP(')).toBe(1);
  });

  it('keeps the position so the parent structure still adds up', async () => {
    const world = await restrictedWorld();
    const text = await exportStep(world.outsider, world.top.revisionId);

    // Both of the top assembly's positions survive, quantities intact.
    expect(occurrences(entities(text), 'NEXT_ASSEMBLY_USAGE_OCCURRENCE()')).toBe(2);
    expect(text).toContain('CONTEXT_DEPENDENT_MEASURE(7.)');
    expect(text).toContain("PRODUCT_DEFINITION_RELATIONSHIP('10',");
    // The stand-in is distinct per position rather than a shared 'Restricted' id, which an
    // importer would merge into one phantom part.
    expect(text).toMatch(/=PRODUCT\('RESTRICTED-\d+','Restricted',\$,\(#\d+\)\);/);
    expect(text).toContain("PRODUCT_DEFINITION('RESTRICTED',$,");
  });

  it('exports the restricted part in full to someone who can read it', async () => {
    const world = await restrictedWorld();
    const text = await exportStep(world.insider, world.top.revisionId);

    expect(text).toContain("'ACL-SECRET'");
    expect(text).toContain("'Classified actuator'");
    expect(text).toContain("'ACL-BURIED'");
    expect(text).not.toContain('RESTRICTED-');
    expect(occurrences(entities(text), 'NEXT_ASSEMBLY_USAGE_OCCURRENCE()')).toBe(3);
  });

  it('answers 404, not 403, when the root revision itself is restricted', async () => {
    const world = await restrictedWorld();
    const res = await world.outsider.get(
      `/api/revisions/${world.secret.revisionId}/export/step`
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Revision not found');
  });

  it('exports everything for an admin', async () => {
    const world = await restrictedWorld();
    const admin = await createAndLogin({ role: Role.ADMIN });
    const text = await exportStep(admin, world.top.revisionId);

    expect(text).toContain("'ACL-SECRET'");
    expect(occurrences(entities(text), 'NEXT_ASSEMBLY_USAGE_OCCURRENCE()')).toBe(3);
  });
});
