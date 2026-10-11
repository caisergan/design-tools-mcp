// A small JSON Schema validator — only the keywords this repo's schemas use (catalog/metadata/schema.json and the
// tool output schemas in tools/schemas.mjs). No dependency (MCP-PLAN decision 1).
//
//   type (a list allows "null"; "number" accepts integers) · enum · const · required · properties ·
//   additionalProperties (false or a schema) · items · minItems · maxItems · uniqueItems · minLength · maxLength ·
//   pattern · minimum · maximum · if / then / else · allOf · $ref into the root schema's $defs
//
// `closed: true` treats every object schema with `properties` as additionalProperties:false unless it says otherwise —
// the tool output check in mcp.test.mjs uses it so structuredContent cannot drift away from its schema.

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Problems of `value` against `schema` as "path: what" strings; [] when it is valid. */
export function schemaProblems(schema, value, { closed = false, root = schema, path = "$" } = {}) {
  const opts = { closed, root };
  const sub = (s, v, p) => schemaProblems(s, v, { ...opts, path: p });
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${path}: not allowed`];
  if (schema.$ref) {
    const name = schema.$ref.replace("#/$defs/", "");
    if (!root.$defs?.[name]) return [`${path}: unknown $ref ${schema.$ref}`];
    return sub(root.$defs[name], value, path);
  }
  const t = typeOf(value);
  const types = [].concat(schema.type || []);
  if (types.length && !types.some((x) => x === t || (x === "number" && t === "integer"))) return [`${path}: ${t}, expected ${types.join(" | ")}`];
  if (schema.enum && !schema.enum.some((e) => same(e, value))) return [`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`];
  if (schema.const !== undefined && !same(schema.const, value)) return [`${path}: ${JSON.stringify(value)}, expected ${JSON.stringify(schema.const)}`];
  const out = [];
  for (const s of schema.allOf || []) out.push(...sub(s, value, path));
  if (schema.if) {
    // a condition is a test, never closed: `{properties: {status: …}}` must not fail on the record's other fields
    const branch = schemaProblems(schema.if, value, { root, path }).length ? schema.else : schema.then;
    if (branch) out.push(...sub(branch, value, path));
  }
  if (t === "string") {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) out.push(`${path}: shorter than ${schema.minLength} chars`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) out.push(`${path}: ${[...value].length} chars, max ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) out.push(`${path}: ${JSON.stringify(value.slice(0, 80))} does not match ${schema.pattern}`);
  }
  if (t === "number" || t === "integer") {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${path}: ${value} < ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${path}: ${value} > ${schema.maximum}`);
  }
  if (t === "object") {
    for (const k of schema.required || []) if (!Object.hasOwn(value, k)) out.push(`${path}.${k}: missing`);
    const props = schema.properties || {};
    const extra = schema.additionalProperties ?? (closed && schema.properties ? false : true);
    for (const k of Object.keys(value)) {
      if (Object.hasOwn(props, k)) out.push(...sub(props[k], value[k], `${path}.${k}`));
      else if (extra === false) out.push(`${path}.${k}: not declared`);
      else if (extra !== true) out.push(...sub(extra, value[k], `${path}.${k}`));
    }
  }
  if (t === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${path}: ${value.length} items, min ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${path}: ${value.length} items, max ${schema.maxItems}`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) out.push(`${path}: items are not unique`);
    if (schema.items) value.forEach((v, i) => out.push(...sub(schema.items, v, `${path}[${i}]`)));
  }
  return out;
}
