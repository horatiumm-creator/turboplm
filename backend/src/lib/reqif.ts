/**
 * ReqIF 1.2 — the OMG Requirements Interchange Format, as TurboPLM speaks it.
 *
 * This module is the whole of the format knowledge: it turns rows into a document and a
 * document back into rows, and it touches neither the database nor Express. The route in
 * routes/requirements.ts owns ACLs and transactions; everything here is pure, which is what
 * lets the round-trip be tested without a server and what keeps the format rules in one
 * readable place instead of smeared across a handler.
 *
 * ---------------------------------------------------------------------------------
 * WHY A PARSER DEPENDENCY WAS ADDED
 * ---------------------------------------------------------------------------------
 * backend/package.json carried nothing that could read XML. The closest thing in the
 * codebase is the BMEcat reader in lib/catalogParse.ts, and it is deliberately not general:
 * it is a hand-rolled forward scanner that recognises one vendor dialect's article records
 * and would have to grow attribute handling, namespace handling, entity handling and
 * arbitrary nesting to read a ReqIF file. Growing it would mean maintaining an XML parser as
 * a side effect of a requirements feature, and the failure mode of a nearly-correct XML
 * parser on a file from DOORS is silently wrong data. So `fast-xml-parser` is a new
 * dependency, chosen for having exactly one transitive dependency (`strnum`) and for
 * supporting `preserveOrder`, without which SPEC-HIERARCHY nesting — the only place ReqIF
 * records the requirement tree — cannot be read back in document order.
 *
 * ---------------------------------------------------------------------------------
 * WHAT MAKES AN EXPORT BYTE-STABLE
 * ---------------------------------------------------------------------------------
 * Re-exporting unchanged data must produce an identical file, or the export is useless for
 * diffing, for change control and for anyone keeping a .reqif in version control. Three
 * things could have broken that and each is pinned:
 *
 *   1. IDENTIFIERs are UUIDv5, derived from a fixed namespace plus the row id (see
 *      {@link reqifIdentifier}). Never random, never sequence-dependent.
 *   2. Ordering is by `reqNumber` at every level of the hierarchy, never by database order.
 *   3. Timestamps that are not row data — the header CREATION-TIME and the SPECIFICATION's
 *      LAST-CHANGE — are derived from the newest `updatedAt` in the exported set rather than
 *      from the clock. `new Date()` there would change every byte of the header on every
 *      request for data nobody had touched. The datatypes and spec-types carry a fixed
 *      LAST-CHANGE ({@link SCHEMA_LAST_CHANGE}) because they describe this module's mapping,
 *      which changes when this file changes and not when a requirement does.
 */
import { createHash } from 'node:crypto';
import { EcnPriority, RequirementStatus, RequirementType } from '@prisma/client';
import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';

// ---------------------------------------------------------------------------
// Format constants
// ---------------------------------------------------------------------------

/** ReqIF 1.2's namespace. The 20110401 date is part of the name, not a typo. */
export const REQIF_NAMESPACE = 'http://www.omg.org/spec/ReqIF/20110401/reqif.xsd';

/** XHTML, for ATTRIBUTE-VALUE-XHTML content. */
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/**
 * The REQ-IF-VERSION element's value is fixed at "1.0" in every ReqIF release, including
 * 1.2 — it versions the exchange structure, not the specification document. Emitting the
 * specification version here is a common and confusing mistake.
 */
const REQIF_VERSION = '1.0';

const TOOL_ID = 'TurboPLM';

/**
 * The header TITLE and the SPECIFICATION LONG-NAME.
 *
 * A constant rather than a parameter because there is nothing to take it from: TurboPLM runs
 * as one installation over one requirements database, so there is no customer or organisation
 * row whose name this could be. Nothing matches on it — it is the label a receiving tool shows
 * for the module — and a name invented from a config value would only look like provenance it
 * does not have.
 */
const DOCUMENT_TITLE = `${TOOL_ID} requirements`;

/**
 * LAST-CHANGE for the datatypes, spec-types and attribute definitions.
 *
 * Those describe the MAPPING, not the data, so their timestamp must not move when a
 * requirement is edited — otherwise a one-word change to one requirement rewrites every
 * definition line in the file and the diff is useless. Bump it by hand if the mapping below
 * ever changes shape.
 */
const SCHEMA_LAST_CHANGE = '2026-01-01T00:00:00.000Z';

/**
 * Declared ceiling on DATATYPE-DEFINITION-STRING. MAX-LENGTH is optional in the schema, but
 * several tools expect it, so a generous constant is emitted rather than a value computed
 * from the data (which would make a schema declaration move whenever a string got longer).
 * Nothing in this module truncates to it.
 */
const STRING_MAX_LENGTH = 32767;

/**
 * Attribute LONG-NAMEs. This table is the contract in both directions: the exporter writes
 * these names and the importer matches on them, so a rename here changes both halves at once
 * and cannot desynchronise them.
 *
 * `ReqIF.ForeignID`, `ReqIF.Name` and `ReqIF.Text` are the format's reserved conventional
 * names — using them means DOORS, Polarion and codebeamer map the three fields that matter
 * without anyone configuring anything. Everything TurboPLM-specific is prefixed `TurboPLM.`
 * so a foreign tool can see at a glance which columns are ours.
 */
const ATTRIBUTE_NAMES = {
  reqNumber: 'ReqIF.ForeignID',
  title: 'ReqIF.Name',
  statement: 'ReqIF.Text',
  rationale: 'TurboPLM.Rationale',
  acceptance: 'TurboPLM.Acceptance',
  type: 'TurboPLM.Type',
  priority: 'TurboPLM.Priority',
  status: 'TurboPLM.Status',
  createdAt: 'TurboPLM.CreatedAt',
  updatedAt: 'TurboPLM.UpdatedAt',
  links: 'TurboPLM.Links',
} as const;

/**
 * `title` and `statement` are capped exactly where routes/requirements.ts caps them
 * (`requireTitle`, `requireStatement`). An import that wrote a 6 000-character statement
 * would create a row the application's own PATCH route then refuses to save, so the limit
 * belongs on the way in rather than as a surprise on the first edit.
 */
const MAX_TITLE_LENGTH = 200;
const MAX_STATEMENT_LENGTH = 4000;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * The UUIDv5 namespace for every identifier this module emits. A fixed random constant, and
 * it must stay fixed: changing it changes every IDENTIFIER in every export, which to a
 * receiving tool looks like every requirement was deleted and recreated.
 */
const IDENTIFIER_NAMESPACE = 'f0a3d1c4-6e2b-4f5a-9c17-2b8e5d4a7c31';

/** RFC 4122 §4.3 name-based UUID, SHA-1 flavour. No dependency needed for 12 lines. */
function uuidV5(namespace: string, name: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const digest = createHash('sha1').update(namespaceBytes).update(name, 'utf8').digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A stable IDENTIFIER for one thing in this installation.
 *
 * Two properties are being satisfied at once, and both are requirements of the format rather
 * than preferences:
 *
 *  - Uniqueness within a document, and stability across exports of it. The name is the kind
 *    plus the row key, so no two things derive the same UUID and the same thing always derives
 *    the identifier it had last time. The scope is deliberately this installation: TurboPLM
 *    holds one requirements database, and an identifier only has to tell apart the things
 *    travelling in the same file. A deployment that ever had to interchange with a SECOND
 *    TurboPLM installation would have to add an installation id to the name below, because
 *    requirement 1 is requirement 1 in both.
 *  - `xsd:ID` validity. ReqIF types IDENTIFIER as xsd:ID, which is an NCName, and an NCName
 *    may not begin with a digit — so a bare UUID is invalid roughly half the time, at random,
 *    which is the worst possible way for a bug to present. The `TPLM-<KIND>-` prefix fixes
 *    the first character and doubles as a legible hint when reading a file by eye.
 */
export function reqifIdentifier(kind: string, key: string | number): string {
  return `TPLM-${kind}-${uuidV5(IDENTIFIER_NAMESPACE, `${kind}:${key}`)}`;
}

// ---------------------------------------------------------------------------
// The enumerations
// ---------------------------------------------------------------------------

interface EnumDatatype {
  /** LONG-NAME of the DATATYPE-DEFINITION-ENUMERATION. */
  longName: string;
  /** Literals, in schema declaration order — the order fixes the EMBEDDED-VALUE KEYs. */
  values: readonly string[];
}

/**
 * `Object.values` on a Prisma enum yields the literals in schema.prisma declaration order,
 * so the EMBEDDED-VALUE KEY ordinals are derived from the schema rather than copied out of
 * it. Adding a literal to the schema therefore adds it to the export automatically; the only
 * thing that must not happen is REORDERING an existing enum, which would silently change
 * every ordinal a receiving tool has already seen.
 */
const ENUM_DATATYPES = {
  type: { longName: 'TurboPLM.RequirementType', values: Object.values(RequirementType) },
  priority: { longName: 'TurboPLM.RequirementPriority', values: Object.values(EcnPriority) },
  status: { longName: 'TurboPLM.RequirementStatus', values: Object.values(RequirementStatus) },
} as const satisfies Record<string, EnumDatatype>;

type EnumField = keyof typeof ENUM_DATATYPES;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * One RequirementLink, already resolved and already ACL-filtered by the caller.
 *
 * `identifier` is the part number or document number — or the literal `Restricted` for a
 * target the caller may not read, which is the same substitution the BOM CSV export makes
 * (lib/acl.ts `REDACTED`). Keeping the row and dropping the identity preserves the link
 * COUNT, which is not sensitive, while an export that simply omitted hidden links would
 * quietly under-report coverage in the traceability matrix.
 */
export interface ReqifLinkRef {
  kind: 'PART' | 'DOCUMENT';
  identifier: string;
}

/** A requirement row, in the shape the exporter needs. Mirrors the Prisma model. */
export interface ReqifRequirement {
  id: number;
  reqNumber: string;
  title: string;
  statement: string;
  type: RequirementType;
  priority: EcnPriority;
  status: RequirementStatus;
  rationale: string | null;
  acceptance: string | null;
  parentId: number | null;
  createdAt: Date;
  updatedAt: Date;
  links: ReqifLinkRef[];
}

export interface ReqifExportInput {
  requirements: ReqifRequirement[];
}

/**
 * One requirement read back out of a document.
 *
 * The nullable enum fields mean "the file did not say", which the caller resolves differently
 * for a create than for an update — see the note on {@link parseReqifDocument}. `title` and
 * `statement` are not nullable because a file that omits them is rejected outright.
 */
export interface ReqifImportedRequirement {
  reqNumber: string;
  title: string;
  statement: string;
  type: RequirementType | null;
  priority: EcnPriority | null;
  status: RequirementStatus | null;
  rationale: string | null;
  acceptance: string | null;
  createdAt: Date | null;
  /** From SPEC-HIERARCHY nesting. Null for a root. */
  parentReqNumber: string | null;
}

export interface ReqifDocument {
  /** In document order, deduplicated by reqNumber (a repeat is rejected, never merged). */
  requirements: ReqifImportedRequirement[];
  /** SPEC-OBJECTs carrying no `ReqIF.ForeignID` — see {@link parseReqifDocument}. */
  skipped: number;
  /**
   * Attribute VALUES whose definition is not one of ours. Dropped, but counted.
   *
   * Counted per value rather than per definition on purpose: the number a user needs is how
   * much data went missing, not how many columns the source tool had. A module with three
   * unmapped attributes across four hundred requirements dropped twelve hundred values.
   */
  unknownAttributesDropped: number;
  /** Individual links in `TurboPLM.Links` — recognised, deliberately not applied, never silent. */
  linksIgnored: number;
}

/**
 * A document this module refuses to read. Always the caller's fault, always a 400: the route
 * turns it into an HttpError verbatim, because the message names the specific thing that was
 * wrong and "invalid ReqIF file" helps nobody debug a 40 MB export from DOORS.
 */
export class ReqifParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReqifParseError';
  }
}

// ---------------------------------------------------------------------------
// fast-xml-parser's preserveOrder tree, and the handful of accessors it needs
// ---------------------------------------------------------------------------

/*
 * In `preserveOrder` mode a node is an object with exactly one tag key whose value is the
 * array of child nodes, plus an optional `:@` key holding the attributes:
 *
 *     { 'SPEC-OBJECT': [ ...children ], ':@': { '@IDENTIFIER': 'x' } }
 *     { '#text': 'some text' }
 *
 * That representation is the reason this mode is used at all — a document-order array is the
 * only way to read SPEC-HIERARCHY nesting and repeated siblings faithfully. The accessors
 * below are the only place its shape is known.
 */

const ATTRS_KEY = ':@';
const TEXT_KEY = '#text';

type XmlNode = Record<string, unknown>;

/** The element's tag, or `#text`. */
function tagOf(node: XmlNode): string {
  for (const key of Object.keys(node)) {
    if (key !== ATTRS_KEY) return key;
  }
  return '';
}

/**
 * The tag without its namespace prefix.
 *
 * Every element lookup in this module goes through this. A ReqIF file is free to bind the
 * ReqIF namespace to a prefix — `<reqif:SPEC-OBJECT>` is as valid as `<SPEC-OBJECT>` under a
 * default xmlns — and a reader that matched raw tag names would work against its own exports
 * and fail against half the tools in the market.
 */
function localName(tag: string): string {
  const colon = tag.lastIndexOf(':');
  return colon === -1 ? tag : tag.slice(colon + 1);
}

function childrenOf(node: XmlNode): XmlNode[] {
  const value = node[tagOf(node)];
  return Array.isArray(value) ? (value as XmlNode[]) : [];
}

function attributeOf(node: XmlNode, name: string): string | null {
  const attrs = node[ATTRS_KEY];
  if (attrs === null || typeof attrs !== 'object') return null;
  const value = (attrs as Record<string, unknown>)[`@${name}`];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** Direct child elements with this local name. */
function childElements(node: XmlNode, name: string): XmlNode[] {
  return childrenOf(node).filter((child) => localName(tagOf(child)) === name);
}

function firstChildElement(node: XmlNode, name: string): XmlNode | null {
  return childElements(node, name)[0] ?? null;
}

/** Every direct child that is an element rather than a text node. */
function elementChildren(node: XmlNode): XmlNode[] {
  return childrenOf(node).filter((child) => tagOf(child) !== TEXT_KEY);
}

/** All descendant text, concatenated in document order. */
function textOf(node: XmlNode): string {
  let out = '';
  for (const child of childrenOf(node)) {
    if (tagOf(child) === TEXT_KEY) {
      const value = child[TEXT_KEY];
      out += typeof value === 'string' ? value : String(value ?? '');
    } else {
      out += textOf(child);
    }
  }
  return out;
}

/** The text of a `<SPEC-OBJECT-REF>`-style element, trimmed of layout whitespace. */
function refText(node: XmlNode | null): string | null {
  if (!node) return null;
  const value = textOf(node).trim();
  return value === '' ? null : value;
}

// ---------------------------------------------------------------------------
// XHTML <-> plain text
// ---------------------------------------------------------------------------

/**
 * Flatten an `<ATTRIBUTE-VALUE-XHTML><THE-VALUE>` payload to the plain text our columns hold.
 *
 * `statement`, `rationale` and `acceptance` are plain `String` columns, so some flattening is
 * unavoidable — a file from DOORS carries tables and lists we have nowhere to put. The rule
 * has two branches on purpose:
 *
 *  - No markup below the wrapper (which is every value this module writes): the text is taken
 *    VERBATIM, only trimmed at the ends. That is what makes a multi-line statement survive a
 *    round trip intact — collapsing whitespace unconditionally would quietly reflow every
 *    paragraph a user had typed.
 *  - Markup present: whitespace is collapsed, because the newlines and indentation between
 *    `<li>` elements in a foreign file are the file's layout, not the author's text, and
 *    keeping them produces a statement full of ragged blank runs.
 */
function xhtmlToPlainText(theValue: XmlNode): string {
  let inner = theValue;
  // Peel wrapper elements — typically <xhtml:div> — while they carry no text of their own.
  for (;;) {
    const elements = elementChildren(inner);
    const ownText = childrenOf(inner)
      .filter((child) => tagOf(child) === TEXT_KEY)
      .map((child) => String(child[TEXT_KEY] ?? ''))
      .join('');
    if (elements.length !== 1 || ownText.trim() !== '') break;
    inner = elements[0];
  }
  const raw = textOf(inner);
  return elementChildren(inner).length > 0 ? raw.replace(/\s+/g, ' ').trim() : raw.trim();
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

type XmlAttrs = Record<string, string>;

/** Build a preserveOrder element node. */
function el(tag: string, children: XmlNode[] = [], attrs?: XmlAttrs): XmlNode {
  const node: XmlNode = { [tag]: children };
  if (attrs && Object.keys(attrs).length > 0) {
    node[ATTRS_KEY] = Object.fromEntries(
      Object.entries(attrs).map(([key, value]) => [`@${key}`, value])
    );
  }
  return node;
}

/** Build an element whose only content is text. */
function textEl(tag: string, value: string): XmlNode {
  return { [tag]: [{ [TEXT_KEY]: value }] };
}

/** ReqIF dates are xsd:dateTime; ISO 8601 with a `Z` offset satisfies every tool. */
function isoDate(value: Date): string {
  return value.toISOString();
}

/**
 * A `<DEFINITION>` block pointing at an attribute definition. `refTag` differs per attribute
 * kind (`ATTRIBUTE-DEFINITION-STRING-REF`, `-XHTML-REF`, …) because ReqIF types its
 * references rather than using one generic ref element.
 */
function definitionRef(refTag: string, identifier: string): XmlNode {
  return el('DEFINITION', [textEl(refTag, identifier)]);
}

function stringValue(identifier: string, value: string): XmlNode {
  return el(
    'ATTRIBUTE-VALUE-STRING',
    [definitionRef('ATTRIBUTE-DEFINITION-STRING-REF', identifier)],
    { 'THE-VALUE': value }
  );
}

function xhtmlValue(identifier: string, value: string): XmlNode {
  /*
   * THE-VALUE is an ELEMENT here, not an attribute as it is on the string and date forms,
   * and its content is XHTML in the XHTML namespace rather than escaped text. The wrapping
   * <xhtml:div> is what makes it well-formed XHTML content rather than a bare text node;
   * tools that render ReqIF expect an element to render.
   */
  return el('ATTRIBUTE-VALUE-XHTML', [
    definitionRef('ATTRIBUTE-DEFINITION-XHTML-REF', identifier),
    el('THE-VALUE', [textEl('xhtml:div', value)]),
  ]);
}

function dateValue(identifier: string, value: Date): XmlNode {
  return el('ATTRIBUTE-VALUE-DATE', [definitionRef('ATTRIBUTE-DEFINITION-DATE-REF', identifier)], {
    'THE-VALUE': isoDate(value),
  });
}

function enumValue(field: EnumField, literal: string): XmlNode {
  return el('ATTRIBUTE-VALUE-ENUMERATION', [
    definitionRef(
      'ATTRIBUTE-DEFINITION-ENUMERATION-REF',
      reqifIdentifier('AD', ATTRIBUTE_NAMES[field])
    ),
    el('VALUES', [
      textEl(
        'ENUM-VALUE-REF',
        reqifIdentifier('EV', `${ENUM_DATATYPES[field].longName}:${literal}`)
      ),
    ]),
  ]);
}

/**
 * The links extension, as a flat string.
 *
 * DECISION, and the reasoning the brief asks for: RequirementLink points at PARTS and
 * DOCUMENTS, never at another requirement. SPEC-RELATION relates SPEC-OBJECTs to each other,
 * so mapping links onto it would require inventing a SPEC-OBJECT per part and per document —
 * which would tell a receiving tool that TurboPLM's parts are requirements, and would come
 * back on the next import as a pile of bogus requirements. That is worse than not exporting
 * the links at all.
 *
 * They are carried instead as one `TurboPLM.Links` string attribute, named so that no tool
 * mistakes it for standard content, and the importer deliberately does not apply it (a part
 * number out of a foreign tool's file names nothing in this catalogue, and inventing parts
 * from a requirements document is not something an import should ever do). The importer counts
 * what it ignores and reports it, so the drop is visible rather than discovered later.
 */
function linksAttribute(links: ReqifLinkRef[]): string {
  return links.map((link) => `${link.kind}:${link.identifier}`).join('; ');
}

function specObject(requirement: ReqifRequirement): XmlNode {
  const values: XmlNode[] = [
    stringValue(reqifIdentifier('AD', ATTRIBUTE_NAMES.reqNumber), requirement.reqNumber),
    stringValue(reqifIdentifier('AD', ATTRIBUTE_NAMES.title), requirement.title),
    xhtmlValue(reqifIdentifier('AD', ATTRIBUTE_NAMES.statement), requirement.statement),
  ];
  // Omitted rather than emitted empty when null — and the importer reads an absent optional
  // attribute back as null, so the pair round-trips exactly.
  if (requirement.rationale !== null) {
    values.push(
      xhtmlValue(reqifIdentifier('AD', ATTRIBUTE_NAMES.rationale), requirement.rationale)
    );
  }
  if (requirement.acceptance !== null) {
    values.push(
      xhtmlValue(reqifIdentifier('AD', ATTRIBUTE_NAMES.acceptance), requirement.acceptance)
    );
  }
  values.push(
    enumValue('type', requirement.type),
    enumValue('priority', requirement.priority),
    enumValue('status', requirement.status),
    dateValue(reqifIdentifier('AD', ATTRIBUTE_NAMES.createdAt), requirement.createdAt),
    dateValue(reqifIdentifier('AD', ATTRIBUTE_NAMES.updatedAt), requirement.updatedAt)
  );
  if (requirement.links.length > 0) {
    values.push(
      stringValue(reqifIdentifier('AD', ATTRIBUTE_NAMES.links), linksAttribute(requirement.links))
    );
  }

  return el(
    'SPEC-OBJECT',
    [
      el('VALUES', values),
      el('TYPE', [textEl('SPEC-OBJECT-TYPE-REF', reqifIdentifier('SOT', 'requirement'))]),
    ],
    {
      IDENTIFIER: reqifIdentifier('SO', requirement.id),
      'LAST-CHANGE': isoDate(requirement.updatedAt),
      // The human-readable identifier, alongside the ReqIF.ForeignID attribute above: tools
      // that show a tree show LONG-NAME, and a tree of blank rows is unusable.
      'LONG-NAME': requirement.reqNumber,
    }
  );
}

function datatypes(): XmlNode {
  const enumerations = (Object.keys(ENUM_DATATYPES) as EnumField[]).map((field) => {
    const { longName, values } = ENUM_DATATYPES[field];
    return el(
      'DATATYPE-DEFINITION-ENUMERATION',
      [
        el(
          'SPECIFIED-VALUES',
          values.map((literal, ordinal) =>
            el(
              'ENUM-VALUE',
              [
                el('PROPERTIES', [
                  // KEY is the ordinal a receiving tool sorts and stores by; OTHER-CONTENT is
                  // required by the schema and has no meaning for us.
                  el('EMBEDDED-VALUE', [], { KEY: String(ordinal), 'OTHER-CONTENT': '' }),
                ]),
              ],
              {
                IDENTIFIER: reqifIdentifier('EV', `${longName}:${literal}`),
                'LAST-CHANGE': SCHEMA_LAST_CHANGE,
                // The importer matches enum literals by LONG-NAME, not by ordinal: a tool
                // that reorders values must not silently turn CRITICAL into LOW.
                'LONG-NAME': literal,
              }
            )
          )
        ),
      ],
      {
        IDENTIFIER: reqifIdentifier('DT', longName),
        'LAST-CHANGE': SCHEMA_LAST_CHANGE,
        'LONG-NAME': longName,
      }
    );
  });

  return el('DATATYPES', [
    el('DATATYPE-DEFINITION-STRING', [], {
      IDENTIFIER: reqifIdentifier('DT', 'String'),
      'LAST-CHANGE': SCHEMA_LAST_CHANGE,
      'LONG-NAME': 'TurboPLM.String',
      'MAX-LENGTH': String(STRING_MAX_LENGTH),
    }),
    el('DATATYPE-DEFINITION-XHTML', [], {
      IDENTIFIER: reqifIdentifier('DT', 'XHTML'),
      'LAST-CHANGE': SCHEMA_LAST_CHANGE,
      'LONG-NAME': 'TurboPLM.XHTML',
    }),
    el('DATATYPE-DEFINITION-DATE', [], {
      IDENTIFIER: reqifIdentifier('DT', 'Date'),
      'LAST-CHANGE': SCHEMA_LAST_CHANGE,
      'LONG-NAME': 'TurboPLM.Date',
    }),
    ...enumerations,
  ]);
}

function attributeDefinition(
  tag: string,
  longName: string,
  typeRefTag: string,
  datatypeKey: string,
  extraAttrs: XmlAttrs = {}
): XmlNode {
  return el(tag, [el('TYPE', [textEl(typeRefTag, reqifIdentifier('DT', datatypeKey))])], {
    IDENTIFIER: reqifIdentifier('AD', longName),
    'LAST-CHANGE': SCHEMA_LAST_CHANGE,
    'LONG-NAME': longName,
    ...extraAttrs,
  });
}

function specTypes(): XmlNode {
  const string = (longName: string) =>
    attributeDefinition(
      'ATTRIBUTE-DEFINITION-STRING',
      longName,
      'DATATYPE-DEFINITION-STRING-REF',
      'String'
    );
  const xhtml = (longName: string) =>
    attributeDefinition(
      'ATTRIBUTE-DEFINITION-XHTML',
      longName,
      'DATATYPE-DEFINITION-XHTML-REF',
      'XHTML'
    );
  const date = (longName: string) =>
    attributeDefinition(
      'ATTRIBUTE-DEFINITION-DATE',
      longName,
      'DATATYPE-DEFINITION-DATE-REF',
      'Date'
    );
  const enumeration = (field: EnumField) =>
    attributeDefinition(
      'ATTRIBUTE-DEFINITION-ENUMERATION',
      ATTRIBUTE_NAMES[field],
      'DATATYPE-DEFINITION-ENUMERATION-REF',
      ENUM_DATATYPES[field].longName,
      // Our enums are single-valued columns. Saying so explicitly stops a receiving tool
      // from offering multi-select on a field that cannot hold two values.
      { 'MULTI-VALUED': 'false' }
    );

  return el('SPEC-TYPES', [
    el(
      'SPEC-OBJECT-TYPE',
      [
        el('SPEC-ATTRIBUTES', [
          string(ATTRIBUTE_NAMES.reqNumber),
          string(ATTRIBUTE_NAMES.title),
          xhtml(ATTRIBUTE_NAMES.statement),
          xhtml(ATTRIBUTE_NAMES.rationale),
          xhtml(ATTRIBUTE_NAMES.acceptance),
          enumeration('type'),
          enumeration('priority'),
          enumeration('status'),
          date(ATTRIBUTE_NAMES.createdAt),
          date(ATTRIBUTE_NAMES.updatedAt),
          string(ATTRIBUTE_NAMES.links),
        ]),
      ],
      {
        IDENTIFIER: reqifIdentifier('SOT', 'requirement'),
        'LAST-CHANGE': SCHEMA_LAST_CHANGE,
        'LONG-NAME': 'TurboPLM Requirement',
      }
    ),
    // A SPECIFICATION must reference a SPECIFICATION-TYPE, so one exists even though it
    // carries no attributes of its own.
    el('SPECIFICATION-TYPE', [], {
      IDENTIFIER: reqifIdentifier('ST', 'requirements'),
      'LAST-CHANGE': SCHEMA_LAST_CHANGE,
      'LONG-NAME': 'TurboPLM Requirements Specification',
    }),
  ]);
}

/**
 * The SPEC-HIERARCHY tree — the ONE place the parent/child relationship lives.
 *
 * This is the part of ReqIF that gets implemented wrongly most often: `parentId` looks like
 * an attribute, so the obvious mapping is to emit it as one. It is not. A SPEC-OBJECT carries
 * no notion of its position; the tree is expressed purely by nesting SPEC-HIERARCHY elements
 * inside a SPECIFICATION, and a tool reading a file where the hierarchy is flat and the
 * parentage is in an attribute shows a flat list.
 *
 * A requirement whose parent is not in `requirements` is emitted at the top level rather than
 * dropped: the caller normally passes every requirement there is, but a partial set must not
 * lose rows silently. The `visited` set is a cheap guard against a cycle in bad data — the
 * database forbids one, but an infinite recursion inside an export is not the way to find out
 * it does not.
 */
function specHierarchy(requirements: ReqifRequirement[]): XmlNode[] {
  const byParent = new Map<number | null, ReqifRequirement[]>();
  const present = new Set(requirements.map((requirement) => requirement.id));
  for (const requirement of requirements) {
    const parent =
      requirement.parentId !== null && present.has(requirement.parentId)
        ? requirement.parentId
        : null;
    const siblings = byParent.get(parent);
    if (siblings) siblings.push(requirement);
    else byParent.set(parent, [requirement]);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.reqNumber.localeCompare(b.reqNumber));
  }

  const visited = new Set<number>();
  const build = (parentId: number | null): XmlNode[] =>
    (byParent.get(parentId) ?? []).flatMap((requirement) => {
      if (visited.has(requirement.id)) return [];
      visited.add(requirement.id);
      const children = build(requirement.id);
      return [
        el(
          'SPEC-HIERARCHY',
          [
            el('OBJECT', [textEl('SPEC-OBJECT-REF', reqifIdentifier('SO', requirement.id))]),
            ...(children.length > 0 ? [el('CHILDREN', children)] : []),
          ],
          {
            IDENTIFIER: reqifIdentifier('SH', requirement.id),
            'LAST-CHANGE': isoDate(requirement.updatedAt),
            'LONG-NAME': requirement.reqNumber,
          }
        ),
      ];
    });

  return build(null);
}

/**
 * Serialise the requirements as a ReqIF 1.2 exchange document.
 *
 * Deterministic: the same rows produce the same bytes, every time. See the module header for
 * the three things that guarantee it.
 */
export function buildReqifDocument(input: ReqifExportInput): string {
  const { requirements } = input;

  /*
   * The document's own timestamp, taken from the newest row in it rather than from the clock.
   * `new Date()` here would mean two exports of untouched data differ, which defeats the
   * whole point of deterministic identifiers.
   */
  const documentTime =
    requirements.length === 0
      ? SCHEMA_LAST_CHANGE
      : isoDate(
          requirements.reduce(
            (newest, requirement) =>
              requirement.updatedAt > newest ? requirement.updatedAt : newest,
            requirements[0].updatedAt
          )
        );

  const ordered = [...requirements].sort((a, b) => a.reqNumber.localeCompare(b.reqNumber));

  /*
   * NOTE on the header's shape. The brief sketched REQ-IF-HEADER's fields in attribute
   * syntax; the ReqIF schema makes IDENTIFIER the only attribute and every other field
   * (COMMENT, CREATION-TIME, REQ-IF-TOOL-ID, REQ-IF-VERSION, SOURCE-TOOL-ID, TITLE) a child
   * element, in that order. The schema wins — interoperating with DOORS and Polarion is the
   * entire point of the feature, and they validate against the published XSD.
   */
  const header = el(
    'REQ-IF-HEADER',
    [
      textEl('COMMENT', `Requirements exported from ${TOOL_ID}.`),
      textEl('CREATION-TIME', documentTime),
      textEl('REQ-IF-TOOL-ID', TOOL_ID),
      textEl('REQ-IF-VERSION', REQIF_VERSION),
      textEl('SOURCE-TOOL-ID', TOOL_ID),
      textEl('TITLE', DOCUMENT_TITLE),
    ],
    { IDENTIFIER: reqifIdentifier('HDR', documentTime) }
  );

  const specification = el(
    'SPECIFICATION',
    [
      el('TYPE', [textEl('SPECIFICATION-TYPE-REF', reqifIdentifier('ST', 'requirements'))]),
      el('CHILDREN', specHierarchy(ordered)),
    ],
    {
      IDENTIFIER: reqifIdentifier('SPEC', 'requirements'),
      'LAST-CHANGE': documentTime,
      'LONG-NAME': DOCUMENT_TITLE,
    }
  );

  const tree: XmlNode[] = [
    { '?xml': [{ [TEXT_KEY]: '' }], [ATTRS_KEY]: { '@version': '1.0', '@encoding': 'UTF-8' } },
    el(
      'REQ-IF',
      [
        el('THE-HEADER', [header]),
        el('CORE-CONTENT', [
          el('REQ-IF-CONTENT', [
            datatypes(),
            specTypes(),
            el('SPEC-OBJECTS', ordered.map(specObject)),
            el('SPECIFICATIONS', [specification]),
          ]),
        ]),
      ],
      { xmlns: REQIF_NAMESPACE, 'xmlns:xhtml': XHTML_NAMESPACE }
    ),
  ];

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    preserveOrder: true,
    format: true,
    indentBy: '  ',
    suppressEmptyNode: true,
  });
  return `${String(builder.build(tree)).trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Parser options, every one of them deliberate:
 *
 *  - `preserveOrder` — SPEC-HIERARCHY nesting and sibling order are the data.
 *  - `parseTagValue` / `parseAttributeValue` false — a title of "42" must stay the string
 *    "42", and a reqNumber must never be coerced to a number.
 *  - `trimValues` false — trimming happens per field, after XHTML flattening, so that the
 *    newlines inside a multi-line statement survive. With trimming on, the text nodes either
 *    side of an inline element lose the spaces that separate the words.
 *  - `processEntities` true — `&amp;` must come back as `&`. fast-xml-parser refuses external
 *    entities outright and does not expand nested internal ones, and this module rejects
 *    DOCTYPE anyway (see below), so this is not an entity-expansion foothold.
 */
const PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  preserveOrder: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
} as const;

/** Attribute-definition IDENTIFIER -> its LONG-NAME, over all spec types in the file. */
function attributeDefinitionNames(content: XmlNode): Map<string, string> {
  const names = new Map<string, string>();
  for (const specTypeBlock of childElements(content, 'SPEC-TYPES')) {
    for (const specType of elementChildren(specTypeBlock)) {
      for (const attributes of childElements(specType, 'SPEC-ATTRIBUTES')) {
        for (const definition of elementChildren(attributes)) {
          const identifier = attributeOf(definition, 'IDENTIFIER');
          const longName = attributeOf(definition, 'LONG-NAME');
          if (identifier !== null && longName !== null) names.set(identifier, longName);
        }
      }
    }
  }
  return names;
}

/** ENUM-VALUE IDENTIFIER -> its LONG-NAME, over every enumeration datatype in the file. */
function enumValueNames(content: XmlNode): Map<string, string> {
  const names = new Map<string, string>();
  for (const datatypeBlock of childElements(content, 'DATATYPES')) {
    for (const datatype of childElements(datatypeBlock, 'DATATYPE-DEFINITION-ENUMERATION')) {
      for (const specified of childElements(datatype, 'SPECIFIED-VALUES')) {
        for (const value of childElements(specified, 'ENUM-VALUE')) {
          const identifier = attributeOf(value, 'IDENTIFIER');
          const longName = attributeOf(value, 'LONG-NAME');
          if (identifier !== null && longName !== null) names.set(identifier, longName);
        }
      }
    }
  }
  return names;
}

/** The attribute-definition LONG-NAME an ATTRIBUTE-VALUE-* points at, or null. */
function definitionNameOf(value: XmlNode, definitionNames: Map<string, string>): string | null {
  const definition = firstChildElement(value, 'DEFINITION');
  if (!definition) return null;
  for (const ref of elementChildren(definition)) {
    const identifier = refText(ref);
    if (identifier === null) continue;
    return definitionNames.get(identifier) ?? null;
  }
  return null;
}

/** Everything one SPEC-OBJECT said, keyed by attribute LONG-NAME. */
interface SpecObjectValues {
  strings: Map<string, string>;
  xhtml: Map<string, string>;
  dates: Map<string, string>;
  enums: Map<string, string>;
  /** Attribute values whose definition is not one of ours (or is unresolvable). */
  unknown: number;
}

function readSpecObjectValues(
  specObjectNode: XmlNode,
  definitionNames: Map<string, string>,
  enumNames: Map<string, string>,
  known: ReadonlySet<string>,
  reqifId: string
): SpecObjectValues {
  const out: SpecObjectValues = {
    strings: new Map(),
    xhtml: new Map(),
    dates: new Map(),
    enums: new Map(),
    unknown: 0,
  };

  for (const valuesBlock of childElements(specObjectNode, 'VALUES')) {
    for (const value of elementChildren(valuesBlock)) {
      const kind = localName(tagOf(value));
      if (!kind.startsWith('ATTRIBUTE-VALUE-')) continue;
      const longName = definitionNameOf(value, definitionNames);
      /*
       * An attribute we do not have — which is everything a DOORS or Polarion module carries
       * beyond the eleven fields below, and there are usually dozens. Dropped, because there
       * is nowhere to put it, but COUNTED, because a user who imports a 300-attribute module
       * and is told "42 requirements created" with no further comment has been misled about
       * what they now have. An unresolvable DEFINITION ref lands here too: an attribute we
       * cannot even name is by definition one we cannot map.
       */
      if (longName === null || !known.has(longName)) {
        out.unknown += 1;
        continue;
      }

      switch (kind) {
        case 'ATTRIBUTE-VALUE-STRING': {
          const raw = attributeOf(value, 'THE-VALUE');
          if (raw !== null) out.strings.set(longName, raw.trim());
          break;
        }
        case 'ATTRIBUTE-VALUE-XHTML': {
          const theValue = firstChildElement(value, 'THE-VALUE');
          if (theValue) out.xhtml.set(longName, xhtmlToPlainText(theValue));
          break;
        }
        case 'ATTRIBUTE-VALUE-DATE': {
          const raw = attributeOf(value, 'THE-VALUE');
          if (raw !== null) out.dates.set(longName, raw.trim());
          break;
        }
        case 'ATTRIBUTE-VALUE-ENUMERATION': {
          const valuesNode = firstChildElement(value, 'VALUES');
          const ref = valuesNode ? refText(firstChildElement(valuesNode, 'ENUM-VALUE-REF')) : null;
          if (ref === null) {
            throw new ReqifParseError(
              `SPEC-OBJECT ${reqifId}: attribute ${longName} has no ENUM-VALUE-REF.`
            );
          }
          const literal = enumNames.get(ref);
          if (literal === undefined) {
            throw new ReqifParseError(
              `SPEC-OBJECT ${reqifId}: attribute ${longName} references enum value "${ref}", ` +
                'which the file does not define.'
            );
          }
          out.enums.set(longName, literal);
          break;
        }
        default:
          // A typed value kind we do not read — BOOLEAN, INTEGER, REAL. Same treatment as an
          // attribute we do not know: dropped, counted, never silent.
          out.unknown += 1;
      }
    }
  }
  return out;
}

function parseEnumLiteral<T extends string>(
  field: EnumField,
  literal: string | undefined,
  allowed: readonly T[],
  reqNumber: string
): T | null {
  if (literal === undefined) return null;
  if ((allowed as readonly string[]).includes(literal)) return literal as T;
  throw new ReqifParseError(
    `Requirement ${reqNumber}: ${ATTRIBUTE_NAMES[field]} is "${literal}", which is not one of ` +
      `${allowed.join(', ')}.`
  );
}

function parseDateValue(raw: string | undefined, label: string, reqNumber: string): Date | null {
  if (raw === undefined) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new ReqifParseError(`Requirement ${reqNumber}: ${label} is not a valid date ("${raw}").`);
  }
  return parsed;
}

/**
 * Read a ReqIF document.
 *
 * VALIDATION IS COMPLETE BEFORE THE CALLER WRITES ANYTHING. Every check that can be made
 * against the file alone is made here and throws {@link ReqifParseError}, so the route can
 * parse first and open its transaction second; a file that is malformed halfway through
 * cannot leave half a requirement tree behind. Checks that need the database — a re-parenting
 * that would form a cycle against rows the file does not mention — belong to the route and
 * run inside its transaction.
 *
 * WHAT "ABSENT" MEANS, per field, because it differs and the difference is deliberate:
 *  - `title`, `statement` absent  -> rejected. Both are NOT NULL columns and this module's own
 *    exports always carry them, so an absence is a broken file rather than an omission.
 *  - `rationale`, `acceptance` absent -> null. The exporter omits them when null, so the pair
 *    round-trips exactly, and they are free-text annotations rather than controlled state.
 *  - `type`, `priority`, `status` absent -> null, meaning "the file did not say". The route
 *    then uses the column default on a create and leaves the existing value alone on an
 *    update: a file that never mentions status must not silently reset an APPROVED
 *    requirement to DRAFT.
 */
export function parseReqifDocument(xml: string): ReqifDocument {
  if (xml.trim() === '') throw new ReqifParseError('The file is empty.');

  /*
   * DOCTYPE is refused outright, before parsing.
   *
   * A ReqIF file has no legitimate use for a document type declaration, and every classic XML
   * attack — external entity reads of /etc/passwd or of an internal URL, billion-laughs
   * expansion — arrives through one. fast-xml-parser already refuses external entities and
   * does not expand entities recursively, so this is defence in depth rather than the only
   * control; it is here because this endpoint takes an uploaded file from anyone with an
   * ENGINEER role, and a cheap categorical refusal beats relying on a third party's parser
   * staying careful forever.
   */
  if (/<!DOCTYPE/i.test(xml)) {
    throw new ReqifParseError(
      'The file carries a DOCTYPE declaration, which is not accepted: ReqIF documents do not ' +
        'need one and it is the vector for XML entity-expansion attacks. Re-export without it.'
    );
  }

  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (validation !== true) {
    const { msg, line, col } = validation.err;
    throw new ReqifParseError(`The file is not well-formed XML: ${msg} (line ${line}, column ${col}).`);
  }

  let tree: XmlNode[];
  try {
    tree = new XMLParser(PARSER_OPTIONS).parse(xml) as XmlNode[];
  } catch (err) {
    throw new ReqifParseError(`The file could not be parsed: ${(err as Error).message}`);
  }

  const root = tree.find((node) => localName(tagOf(node)) === 'REQ-IF');
  if (!root) {
    const found = tree.map((node) => tagOf(node)).filter((tag) => tag !== '?xml');
    throw new ReqifParseError(
      `The root element is ${found.length > 0 ? `<${found[0]}>` : 'missing'}, not <REQ-IF>. ` +
        'This is not a ReqIF document.'
    );
  }

  const coreContent = firstChildElement(root, 'CORE-CONTENT');
  const content = coreContent ? firstChildElement(coreContent, 'REQ-IF-CONTENT') : null;
  if (!content) {
    throw new ReqifParseError('The document has no CORE-CONTENT/REQ-IF-CONTENT section.');
  }

  const definitionNames = attributeDefinitionNames(content);
  const enumNames = enumValueNames(content);
  const known = new Set<string>(Object.values(ATTRIBUTE_NAMES));

  // ---- SPEC-OBJECTS -------------------------------------------------------
  let skipped = 0;
  let unknownAttributesDropped = 0;
  let linksIgnored = 0;

  /** SPEC-OBJECT IDENTIFIER -> the requirement read out of it. */
  const byReqifId = new Map<string, ReqifImportedRequirement>();
  const seenReqNumbers = new Map<string, string>();

  for (const objectsBlock of childElements(content, 'SPEC-OBJECTS')) {
    for (const specObjectNode of childElements(objectsBlock, 'SPEC-OBJECT')) {
      const reqifId = attributeOf(specObjectNode, 'IDENTIFIER');
      if (reqifId === null) {
        throw new ReqifParseError('A SPEC-OBJECT has no IDENTIFIER attribute.');
      }
      if (byReqifId.has(reqifId)) {
        throw new ReqifParseError(`SPEC-OBJECT IDENTIFIER "${reqifId}" appears more than once.`);
      }

      const values = readSpecObjectValues(
        specObjectNode,
        definitionNames,
        enumNames,
        known,
        reqifId
      );
      unknownAttributesDropped += values.unknown;
      // Counted even when the object is skipped below: it was still data the import dropped.
      const linksValue = values.strings.get(ATTRIBUTE_NAMES.links);
      if (linksValue !== undefined) {
        linksIgnored += linksValue.split(';').filter((entry) => entry.trim() !== '').length;
      }

      const reqNumber = values.strings.get(ATTRIBUTE_NAMES.reqNumber);
      if (reqNumber === undefined || reqNumber === '') {
        /*
         * No ReqIF.ForeignID, so there is nothing to match on — and matching is what keeps
         * this endpoint from duplicating. Generating a number instead would look helpful
         * exactly once: the number differs on every run, so re-importing the same file would
         * create a second copy of the whole document, which is the one failure the brief
         * calls out. Skipped and counted.
         */
        skipped += 1;
        continue;
      }
      const duplicate = seenReqNumbers.get(reqNumber);
      if (duplicate !== undefined) {
        throw new ReqifParseError(
          `Requirement ${reqNumber} appears twice in the file (SPEC-OBJECTs ${duplicate} and ` +
            `${reqifId}). Importing it would be ambiguous, so nothing was imported.`
        );
      }
      seenReqNumbers.set(reqNumber, reqifId);

      const title = values.strings.get(ATTRIBUTE_NAMES.title);
      if (title === undefined || title === '') {
        throw new ReqifParseError(
          `Requirement ${reqNumber} has no ${ATTRIBUTE_NAMES.title} value, which is required.`
        );
      }
      if (title.length > MAX_TITLE_LENGTH) {
        throw new ReqifParseError(
          `Requirement ${reqNumber}: ${ATTRIBUTE_NAMES.title} is ${title.length} characters, ` +
            `over the ${MAX_TITLE_LENGTH}-character limit.`
        );
      }

      const statement = values.xhtml.get(ATTRIBUTE_NAMES.statement);
      if (statement === undefined || statement === '') {
        throw new ReqifParseError(
          `Requirement ${reqNumber} has no ${ATTRIBUTE_NAMES.statement} value, which is required.`
        );
      }
      if (statement.length > MAX_STATEMENT_LENGTH) {
        throw new ReqifParseError(
          `Requirement ${reqNumber}: ${ATTRIBUTE_NAMES.statement} is ${statement.length} ` +
            `characters, over the ${MAX_STATEMENT_LENGTH}-character limit.`
        );
      }

      const optionalText = (longName: string): string | null => {
        const value = values.xhtml.get(longName);
        return value === undefined || value === '' ? null : value;
      };

      byReqifId.set(reqifId, {
        reqNumber,
        title,
        statement,
        type: parseEnumLiteral(
          'type',
          values.enums.get(ATTRIBUTE_NAMES.type),
          Object.values(RequirementType),
          reqNumber
        ),
        priority: parseEnumLiteral(
          'priority',
          values.enums.get(ATTRIBUTE_NAMES.priority),
          Object.values(EcnPriority),
          reqNumber
        ),
        status: parseEnumLiteral(
          'status',
          values.enums.get(ATTRIBUTE_NAMES.status),
          Object.values(RequirementStatus),
          reqNumber
        ),
        rationale: optionalText(ATTRIBUTE_NAMES.rationale),
        acceptance: optionalText(ATTRIBUTE_NAMES.acceptance),
        createdAt: parseDateValue(
          values.dates.get(ATTRIBUTE_NAMES.createdAt),
          ATTRIBUTE_NAMES.createdAt,
          reqNumber
        ),
        parentReqNumber: null,
      });
    }
  }

  // ---- SPEC-HIERARCHY -----------------------------------------------------
  /*
   * The tree, and only now: parentage is nesting, so it cannot be read until every
   * SPEC-OBJECT it might reference has been seen.
   *
   * `nearestAncestor` is what makes a hierarchy node that references a missing or skipped
   * SPEC-OBJECT transparent rather than fatal — its children attach to the closest ancestor
   * that did resolve. A file whose hierarchy points at an object it never defines is
   * malformed, but dropping that node's entire subtree because of it would lose real
   * requirements over a broken reference.
   */
  const placed = new Set<string>();
  const walk = (hierarchyNodes: XmlNode[], nearestAncestor: string | null): void => {
    for (const node of hierarchyNodes) {
      const objectNode = firstChildElement(node, 'OBJECT');
      const ref = objectNode ? refText(firstChildElement(objectNode, 'SPEC-OBJECT-REF')) : null;
      const requirement = ref === null ? undefined : byReqifId.get(ref);

      let childAncestor = nearestAncestor;
      if (requirement !== undefined && !placed.has(ref as string)) {
        // First occurrence wins. ReqIF permits one SPEC-OBJECT to appear in several places;
        // `parentId` holds exactly one, so a later appearance is ignored rather than allowed
        // to overwrite the first and make the result depend on document order twice over.
        placed.add(ref as string);
        requirement.parentReqNumber = nearestAncestor;
        childAncestor = requirement.reqNumber;
      } else if (requirement !== undefined) {
        childAncestor = requirement.reqNumber;
      }

      for (const children of childElements(node, 'CHILDREN')) {
        walk(childElements(children, 'SPEC-HIERARCHY'), childAncestor);
      }
    }
  };

  for (const specsBlock of childElements(content, 'SPECIFICATIONS')) {
    for (const specification of childElements(specsBlock, 'SPECIFICATION')) {
      for (const children of childElements(specification, 'CHILDREN')) {
        walk(childElements(children, 'SPEC-HIERARCHY'), null);
      }
    }
  }

  return {
    // A SPEC-OBJECT that no SPECIFICATION references is still a requirement; it simply has no
    // parent. Dropping it would lose data over a formatting choice of the exporting tool.
    requirements: [...byReqifId.values()],
    skipped,
    unknownAttributesDropped,
    linksIgnored,
  };
}
