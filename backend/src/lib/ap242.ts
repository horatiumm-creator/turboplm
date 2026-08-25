/**
 * AP242 product-structure export — an ISO 10303-21 ("Part 21") physical file.
 *
 * =============================================================================
 * PRODUCT STRUCTURE ONLY. THIS FILE FORMAT CARRIES NO GEOMETRY, BY DESIGN.
 * =============================================================================
 * TurboPLM imports CAD and tessellates it for the viewer. It stores no BREP, no
 * topology, no surfaces and no transforms — nothing that could be written back as a
 * shape representation. So this exporter emits the conventional AP242 PDM subset and
 * stops there: products, revisions, categories and assembly usage.
 *
 * That is a deliberate limit rather than an unfinished one. An AP242 file that declares
 * geometry it does not have is worse than one that honestly carries only structure: the
 * receiving system trusts the schema name, opens an assembly with no shapes in it, and
 * the failure surfaces as "TurboPLM's CAD data is broken" rather than "TurboPLM never
 * had CAD data to send". The file therefore says so about itself, twice — once in
 * FILE_DESCRIPTION, where every Part 21 reader looks, and once as a comment at the top
 * of the DATA section, where a human looks. Neither is decoration; do not remove them
 * when geometry is not added, and do not leave them in place if it ever is.
 *
 * -----------------------------------------------------------------------------
 * WHY A PART 21 FILE AND NOT XML
 * -----------------------------------------------------------------------------
 * AP242 also has an XML representation (the "Domain Model XSD"). Teamcenter, Windchill
 * and NX all ingest the Part 21 physical file; support for the XML form is patchier and
 * varies by connector. `.stp` is what the customer's PDM system will actually accept.
 *
 * -----------------------------------------------------------------------------
 * THE ENTITY GRAPH
 * -----------------------------------------------------------------------------
 * Emitted once:
 *   APPLICATION_CONTEXT, APPLICATION_PROTOCOL_DEFINITION,
 *   PRODUCT_CONTEXT, PRODUCT_DEFINITION_CONTEXT, DIMENSIONAL_EXPONENTS
 *   plus one CONTEXT_DEPENDENT_UNIT per distinct unit of measure.
 *
 * Per part:
 *   PRODUCT                          — part number, name, description
 *   PRODUCT_DEFINITION_FORMATION     — the revision, with its change note
 *   PRODUCT_DEFINITION               — the revision's lifecycle state
 *   PRODUCT_RELATED_PRODUCT_CATEGORY — our PartCategory enum
 *
 * Per BOM position:
 *   MEASURE_WITH_UNIT                — the quantity (see QUANTITY below)
 *   a complex instance of NEXT_ASSEMBLY_USAGE_OCCURRENCE
 *     and QUANTIFIED_ASSEMBLY_COMPONENT_USAGE
 *
 * -----------------------------------------------------------------------------
 * QUANTITY — THE DECISION, STATED PLAINLY
 * -----------------------------------------------------------------------------
 * NEXT_ASSEMBLY_USAGE_OCCURRENCE has no quantity attribute. Its six slots are id, name,
 * description, relating/related product definition, and a single optional reference
 * designator. A BOM line's quantity fits in none of them.
 *
 * The tempting shortcut — write "4" into the usage's id or reference designator and call
 * the BOM exported — is a lie. Those attributes are an identifier and a label; an
 * importer reads them as text, drops them into a name field, and instantiates the
 * component ONCE. A four-off component silently becomes a one-off, which is the single
 * most expensive way this export could be wrong: it is invisible in the file, invisible
 * on import, and only shows up when someone builds the assembly.
 *
 * So the conventional carrier is used instead. ISO 10303-44 defines
 *
 *     ENTITY assembly_component_usage
 *       SUPERTYPE OF (ONEOF (next_assembly_usage_occurrence, ...)
 *                     ANDOR quantified_assembly_component_usage)
 *
 * — the ANDOR is what makes a combined instance legal, and it is exactly what the PDM
 * usage guide recommends for assembly quantities. In Part 21 that is a complex entity
 * instance: every partial record, each with its own attribute list, in ALPHABETICAL
 * order of entity name. Ordering is not stylistic; a reader that fails to match the
 * records rejects the instance.
 *
 *   #40=(ASSEMBLY_COMPONENT_USAGE($)NEXT_ASSEMBLY_USAGE_OCCURRENCE()
 *        PRODUCT_DEFINITION_RELATIONSHIP('10','','',#9,#19)PRODUCT_DEFINITION_USAGE()
 *        QUANTIFIED_ASSEMBLY_COMPONENT_USAGE(#39));
 *
 * This is heavier than a bare NAUO — two extra entities per line and a complex instance
 * to get right — and it is worth it. It also degrades honestly: an importer that does
 * not understand QUANTIFIED_ASSEMBLY_COMPONENT_USAGE still reads the
 * NEXT_ASSEMBLY_USAGE_OCCURRENCE partial record and gets the structure, which is the
 * whole point of complex instances. Nothing is misrepresented in either direction.
 *
 * The measure is CONTEXT_DEPENDENT_MEASURE against a CONTEXT_DEPENDENT_UNIT named with
 * the line's own unit of measure, verbatim. TurboPLM's `uom` is free text — 'ea', 'm',
 * 'kg', 'set', whatever the customer types — so mapping it onto SI_UNIT would mean
 * GUESSING what the customer meant, and a wrong guess is a wrong quantity. A
 * context-dependent unit is precisely the standard's provision for a unit it does not
 * define, identified by name in context, and it pairs by type with
 * CONTEXT_DEPENDENT_MEASURE. Its DIMENSIONAL_EXPONENTS are all zero because this system
 * does not model the dimensionality of a unit and will not assert one it does not know.
 *
 * -----------------------------------------------------------------------------
 * DETERMINISM
 * -----------------------------------------------------------------------------
 * Two exports of unchanged data are byte-identical. A diffable export is worth a great
 * deal — it is how a customer reviews what a change did to a configuration — and a
 * randomly-ordered one is worth nothing at all.
 *
 * Three things are pinned:
 *   * Entity ids are assigned in a fixed emission order, never from a hash or a map's
 *     iteration order.
 *   * Parts are emitted in walk order — first encounter in a depth-first traversal taken
 *     in find-number order — so parents precede their components and the file reads in
 *     assembly order. Usages follow (parent, find number, child).
 *   * The FILE_NAME time stamp comes from the DATA, not from the clock: it is the most
 *     recent change time among the parts and revisions exported. Part 21 nominally calls
 *     that field the file's creation time, so this is a deliberate deviation, taken
 *     because a wall-clock stamp would make every export differ from every other and
 *     throw away the diffability the rest of this design pays for. The exported file
 *     says which it is, in the DATA-section comment, so nobody has to guess.
 */

/** The AP242 edition 2 MIM long form. Quoted exactly; readers match on this string. */
const SCHEMA_NAME = 'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 3 1 4 }';

/** Stated in FILE_DESCRIPTION, where a Part 21 reader looks. British spelling: user-facing. */
const NO_GEOMETRY_NOTICE =
  'PRODUCT STRUCTURE ONLY - NO GEOMETRY. This file carries part identification, ' +
  'revisions, categories and assembly quantities. It contains no shape representation ' +
  'of any kind and is not a 3D model.';

/**
 * A part as it appears in the export, with the revision it resolved to.
 *
 * `walkOrder` is the part's first-encounter index in the traversal. It fixes both the
 * emission order and the tie-breaking, so the caller owns traversal and this module owns
 * the file — neither can quietly make the output non-deterministic on its own.
 */
export interface Ap242VisibleNode {
  key: number;
  walkOrder: number;
  restricted: false;
  partNumber: string;
  name: string;
  description: string | null;
  /** The PartCategory enum value, carried on PRODUCT_RELATED_PRODUCT_CATEGORY. */
  category: string;
  revision: string;
  changeNote: string | null;
  /** The Lifecycle enum value, carried as the product definition's id. */
  lifecycle: string;
}

/**
 * A part the caller may not read (rule X4).
 *
 * It deliberately carries NO fields beyond its identity in the graph. The redaction is
 * structural rather than a matter of the caller remembering to blank things out: there is
 * no field here for a part number to leak through, so a caller that has correctly decided
 * an item is hidden cannot then hand its data to the writer by accident.
 */
export interface Ap242RestrictedNode {
  key: number;
  walkOrder: number;
  restricted: true;
}

export type Ap242Node = Ap242VisibleNode | Ap242RestrictedNode;

/** One BOM position. Quantity and unit survive redaction — the structure must add up. */
export interface Ap242Usage {
  parentKey: number;
  childKey: number;
  findNumber: number;
  quantity: number;
  uom: string;
  refDesignators: string | null;
  notes: string | null;
}

export interface Ap242Model {
  /** Download file name, also written into FILE_NAME. */
  fileName: string;
  /** Data-derived, never `new Date()` — see DETERMINISM above. */
  timestamp: Date;
  nodes: Ap242Node[];
  usages: Ap242Usage[];
  /**
   * Anything the walk could not represent faithfully — a cycle it refused to expand, a
   * position it had to drop. Rendered into the DATA-section comment. An export that
   * quietly loses a line is exactly the kind of dishonesty this file exists to avoid.
   */
  notes: string[];
}

/**
 * Escape a string for a Part 21 string literal. This is NOT C escaping, and the
 * differences are the kind that pass review and fail at a customer.
 *
 *   * A single quote is doubled (`''`), not backslash-escaped. Part numbers and part
 *     names here are user data and they DO contain apostrophes — "Ø6 shaft, Dave's rig"
 *     is an ordinary name. Get this wrong and the string terminates early, every
 *     subsequent attribute shifts, and the file is garbage from that entity onward.
 *   * A backslash is doubled, because backslash introduces the control directives below.
 *   * Everything outside printable ASCII goes through `\X2\....\X0\`, which encodes a run
 *     of UTF-16 code units as 4 hex digits each. JavaScript strings are already UTF-16,
 *     so `charCodeAt` yields exactly the right units — including surrogate pairs for
 *     characters beyond the BMP, which `\X2\` is defined to carry as a pair.
 *
 * Consecutive non-ASCII characters share one directive rather than opening and closing
 * one each: shorter, and it is what readers expect to see.
 *
 * Exported because it is the one piece of this module with a sharp edge worth testing on
 * its own, rather than only through a whole file.
 */
export function escapeStepString(value: string): string {
  /*
   * ISO 10303-21 control directives, and the distinction that matters:
   *
   *   \X2\ takes groups of FOUR hex digits, each "a 16-bit number giving an integer position
   *         within the UCS codespace" — that is a CODE POINT in the BMP, not a UTF-16 code unit.
   *   \X4\ takes groups of EIGHT hex digits, for anything above U+FFFF.
   *
   * An earlier version walked the string with charCodeAt and pushed every unit through \X2\,
   * so U+20BB7 — an ordinary CJK Extension B ideograph, and equally any emoji — was written as
   * \X2\D842DFB7\X0\. A conformant reader takes that as two code points in the surrogate
   * range, which are not characters at all. Part numbers and names are user data; this has to
   * be right.
   *
   * Runs are batched: consecutive characters needing the same directive share one, and a
   * directive is closed with \X0\ before switching. That is both what the standard expects and
   * what keeps the output readable.
   */
  let out = '';
  let mode: 'ascii' | 'bmp' | 'astral' = 'ascii';

  const close = (): void => {
    if (mode !== 'ascii') out += '\\X0\\';
    mode = 'ascii';
  };

  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;

    if (cp >= 0x20 && cp <= 0x7e) {
      close();
      // Part 21 escapes an apostrophe by doubling it and a backslash by doubling it. This is
      // not C escaping, and getting it wrong truncates the string at the first apostrophe.
      out += ch === "'" ? "''" : ch === '\\' ? '\\\\' : ch;
      continue;
    }

    const want = cp > 0xffff ? 'astral' : 'bmp';
    if (mode !== want) {
      close();
      out += want === 'astral' ? '\\X4\\' : '\\X2\\';
      mode = want;
    }
    out += cp.toString(16).toUpperCase().padStart(want === 'astral' ? 8 : 4, '0');
  }

  close();
  return out;
}


/** A required Part 21 string attribute. */
function str(value: string): string {
  return `'${escapeStepString(value)}'`;
}

/** An optional Part 21 string attribute: `$` is absent, `''` is present-but-empty. */
function optStr(value: string | null): string {
  return value === null ? '$' : str(value);
}

/**
 * A Part 21 REAL literal, which must always carry a decimal point — `2` is an INTEGER
 * and would be a type error against `measure_value`, so 2 is written `2.`.
 *
 * `String()` gives the shortest round-tripping representation, which keeps the output
 * stable for a given double. Its exponential form (`1e-7`) is not valid Part 21, so the
 * mantissa is given a point and the exponent an uppercase `E`.
 */
function stepReal(value: number): string {
  if (!Number.isFinite(value)) {
    // Unreachable from the routes — quantity is validated `> 0` and finite on write —
    // but a NaN written into a quantity would be a silently wrong BOM, not a bad string.
    throw new Error(`AP242 export: ${String(value)} is not a finite quantity`);
  }
  const text = String(value);
  const exp = text.indexOf('e');
  if (exp === -1) return text.includes('.') ? text : `${text}.`;
  const mantissa = text.slice(0, exp);
  return `${mantissa.includes('.') ? mantissa : `${mantissa}.`}E${text.slice(exp + 1)}`;
}

/**
 * Part 21 time stamp. Any ISO 8601 string is acceptable — FILE_NAME holds it as a plain
 * string attribute — so UTC with an explicit `Z` is used rather than a local time with
 * no offset, which is ambiguous the moment the file crosses a time zone.
 */
function stepTimestamp(when: Date): string {
  return `${when.toISOString().slice(0, 19)}Z`;
}

/**
 * The redacted stand-in for a part the caller may not read.
 *
 * lib/acl.ts's REDACTED uses the single label 'Restricted' for every hidden item, which
 * is right for a JSON tree the user reads. It is wrong here: an importer keys parts by
 * PRODUCT.id, so several hidden components sharing one id would be merged into a single
 * phantom part and the structure would stop adding up. The walk order distinguishes them
 * and discloses nothing — it is a position in a traversal the caller has already been
 * shown, not a property of the hidden part.
 */
function restrictedIdentity(node: Ap242RestrictedNode): {
  partNumber: string;
  name: string;
  revision: string;
  lifecycle: string;
} {
  return {
    partNumber: `RESTRICTED-${node.walkOrder}`,
    name: 'Restricted',
    revision: 'RESTRICTED',
    lifecycle: 'RESTRICTED',
  };
}

/**
 * The DATA-section comment.
 *
 * A Part 21 comment ends at the first close-comment sequence, and the notes interpolate
 * part numbers, which are user data. A part number containing one would close the comment
 * early and turn the rest of the prose into syntax errors, so the body is neutralised
 * before it is wrapped.
 */
function dataComment(model: Ap242Model): string[] {
  const body = [
    'Generated by TurboPLM.',
    NO_GEOMETRY_NOTICE,
    'Quantities are carried on QUANTIFIED_ASSEMBLY_COMPONENT_USAGE complexed with ' +
      'NEXT_ASSEMBLY_USAGE_OCCURRENCE, never in the usage id or reference designator.',
    'The FILE_NAME time stamp is the last time the exported data changed, not the time ' +
      'this file was written, so that two exports of unchanged data are identical.',
    ...model.notes,
  ];
  const text = body.join('\n   ').replace(/\*\//g, '* /');
  return [`/* ${text} */`];
}

/**
 * Render the model as a Part 21 physical file.
 *
 * Pure: same model in, same bytes out. All database access, and in particular all access
 * control, happens before this is called — see the export route in routes/bom.ts.
 *
 * The output is ASCII by construction (every other character went through `\X2\`), so it
 * is safe to send with no charset negotiation at all.
 */
export function writeAp242(model: Ap242Model): string {
  const entities: string[] = [];
  let count = 0;
  const emit = (text: string): string => {
    count += 1;
    entities.push(`#${count}=${text};`);
    return `#${count}`;
  };

  const appContext = emit(`APPLICATION_CONTEXT(${str('managed model based 3d engineering')})`);
  emit(
    `APPLICATION_PROTOCOL_DEFINITION(${str('international standard')},` +
      `${str('ap242_managed_model_based_3d_engineering_mim_lf')},2020,${appContext})`
  );
  const productContext = emit(`PRODUCT_CONTEXT('',${appContext},${str('mechanical')})`);
  const definitionContext = emit(
    `PRODUCT_DEFINITION_CONTEXT(${str('part definition')},${appContext},${str('design')})`
  );

  // One dimensionless exponent set shared by every unit: see the QUANTITY note above for
  // why this asserts no dimensionality rather than guessing at one.
  const dimensions = emit('DIMENSIONAL_EXPONENTS(0.,0.,0.,0.,0.,0.,0.)');
  const unitRefs = new Map<string, string>();
  for (const uom of [...new Set(model.usages.map((usage) => usage.uom))].sort()) {
    unitRefs.set(uom, emit(`CONTEXT_DEPENDENT_UNIT(${dimensions},${str(uom)})`));
  }

  // Walk order, not insertion order: the caller's array is whatever its traversal
  // produced, and sorting here is what makes the guarantee this module's to keep.
  const nodes = [...model.nodes].sort((a, b) => a.walkOrder - b.walkOrder);
  const definitionRefs = new Map<number, string>();
  // Filled in the product loop below and emitted once afterwards — see the category note.
  const productsByCategory = new Map<string, string[]>();
  const allProducts: string[] = [];
  for (const node of nodes) {
    const identity = node.restricted ? restrictedIdentity(node) : node;
    const product = emit(
      `PRODUCT(${str(identity.partNumber)},${str(identity.name)},` +
        `${node.restricted ? '$' : optStr(node.description)},(${productContext}))`
    );
    const formation = emit(
      `PRODUCT_DEFINITION_FORMATION(${str(identity.revision)},` +
        `${node.restricted ? '$' : optStr(node.changeNote)},${product})`
    );
    definitionRefs.set(
      node.key,
      emit(
        `PRODUCT_DEFINITION(${str(identity.lifecycle)},$,${formation},${definitionContext})`
      )
    );
    /*
     * Collected here, emitted once after the loop.
     *
     * Every product joins 'part'. Only an unrestricted one joins a sub-category: 'part' is
     * structural and discloses nothing, whereas MECHANICAL or PURCHASED would say what the
     * hidden item IS. That is the line rule X4 draws, and it falls out naturally here because
     * a restricted node carries no category to leak.
     */
    allProducts.push(product);
    if (!node.restricted) {
      const bucket = productsByCategory.get(node.category);
      if (bucket) bucket.push(product);
      else productsByCategory.set(node.category, [product]);
    }
  }

  /*
   * ONE instance per category, holding every product in it — not one per product.
   *
   * PDM Schema Usage Guide r4.3 §2.1.1: "A given product category shall only be instantiated
   * once in an exchange file." One per product was both a conformance violation and absurd at
   * scale — a 500-part assembly emitted 500 instances across at most six distinct names.
   *
   * The vocabulary matters as much as the count. §1.1.3 makes this entity the mechanism that
   * distinguishes a product interpreted as a PART from one interpreted as a DOCUMENT, and tells
   * postprocessors to expect the name 'part'. Our own enum — MECHANICAL, PURCHASED,
   * RAW_MATERIAL — is outside that vocabulary, so a receiving system found nothing in these
   * files it recognised as a part at all. Everything is now 'part' first, with our category
   * carried beneath it via PRODUCT_CATEGORY_RELATIONSHIP, which is the guide's own mechanism.
   *
   * Restricted nodes are included. §1.1.1.1 requires one category per product, and 'part'
   * discloses nothing about a hidden item — it is structural, the same class of fact as the
   * PRODUCT_DEFINITION already emitted for it. Withholding it bought no privacy and cost
   * validity.
   */
  if (allProducts.length > 0) {
    const partCategory = emit(
      `PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(${allProducts.join(',')}))`
    );
    const buckets = [...productsByCategory].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [category, products] of buckets) {
      const sub = emit(
        `PRODUCT_RELATED_PRODUCT_CATEGORY(${str(category.toLowerCase())},$,(${products.join(',')}))`
      );
      emit(
        `PRODUCT_CATEGORY_RELATIONSHIP('sub-category','TurboPLM part category',` +
          `${partCategory},${sub})`
      );
    }
  }

  const orderOf = new Map(model.nodes.map((node) => [node.key, node.walkOrder]));
  const positionOf = (key: number): number => orderOf.get(key) ?? Number.MAX_SAFE_INTEGER;
  const usages = [...model.usages].sort(
    (a, b) =>
      positionOf(a.parentKey) - positionOf(b.parentKey) ||
      a.findNumber - b.findNumber ||
      positionOf(a.childKey) - positionOf(b.childKey)
  );
  for (const usage of usages) {
    const parent = definitionRefs.get(usage.parentKey);
    const child = definitionRefs.get(usage.childKey);
    if (!parent || !child) {
      // A usage naming a part that was never emitted would produce a dangling #N and an
      // unreadable file. Fail loudly here rather than shipping one.
      throw new Error(
        `AP242 export: usage ${usage.parentKey}->${usage.childKey} references an unknown part`
      );
    }
    const unit = unitRefs.get(usage.uom);
    const quantity = emit(
      `MEASURE_WITH_UNIT(CONTEXT_DEPENDENT_MEASURE(${stepReal(usage.quantity)}),${unit})`
    );
    /*
     * The complex instance. Partial records in ALPHABETICAL order of entity name —
     * ASSEMBLY_COMPONENT_USAGE, NEXT_ASSEMBLY_USAGE_OCCURRENCE,
     * PRODUCT_DEFINITION_RELATIONSHIP, PRODUCT_DEFINITION_USAGE,
     * QUANTIFIED_ASSEMBLY_COMPONENT_USAGE — which is required, not cosmetic.
     *
     * `reference_designator` stays `$` on purpose. It is a single `label`, and this
     * system's `refDesignators` is a free-text list ("R1,R2,R5"); writing a list into a
     * slot the schema says holds one designator would misrepresent it to any importer
     * that splits assemblies by designator. The verbatim text travels as the usage's
     * name instead, where it reads as the prose it is. The find number is the usage id,
     * which is where a PDM system looks for an item number.
     */
    emit(
      `(ASSEMBLY_COMPONENT_USAGE($)NEXT_ASSEMBLY_USAGE_OCCURRENCE()` +
        `PRODUCT_DEFINITION_RELATIONSHIP(${str(String(usage.findNumber))},` +
        `${str(usage.refDesignators ?? '')},${optStr(usage.notes)},${parent},${child})` +
        `PRODUCT_DEFINITION_USAGE()QUANTIFIED_ASSEMBLY_COMPONENT_USAGE(${quantity}))`
    );
  }

  return [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION((${str('TurboPLM product structure export')},` +
      `${str(NO_GEOMETRY_NOTICE)}),'2;1');`,
    `FILE_NAME(${str(model.fileName)},${str(stepTimestamp(model.timestamp))},(''),(''),` +
      `${str('TurboPLM')},'','');`,
    `FILE_SCHEMA((${str(SCHEMA_NAME)}));`,
    'ENDSEC;',
    'DATA;',
    ...dataComment(model),
    ...entities,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}
