// JSON Schemas for the structured answers of tools/mcp.mjs (MCP-PLAN 4.1). A client that negotiated
// 2025-06-18 gets each tool's `outputSchema` in tools/list and `structuredContent` beside the text.
// The text stays the answer an agent reads; structuredContent carries the same facts under stable names
// (every field is always present, null or [] when unknown). Third-party bodies (docs, component source)
// stay in the text inside <untrusted-content> and are described here only by size and position.

const str = { type: "string" };
const nstr = { type: ["string", "null"] };
const int = { type: "integer" };
const nint = { type: ["integer", "null"] };
const bool = { type: "boolean" };
const strs = { type: "array", items: str };
const list = (items) => ({ type: "array", items });
const nenum = (values) => ({ type: ["string", "null"], enum: [...values, null] });
/** Every property is required: a consumer can rely on the field being there. */
const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties) });
const nullable = (schema) => ({ ...schema, type: [schema.type, "null"] });

const ACCESS = ["code", "gated", "page"];
const nextOffset = nint; // the offset of the next page, null on the last
/** A tool schema names a shared hit shape once, in its own `$defs`. */
const ref = (name) => ({ $ref: `#/$defs/${name}` });

/** Which query word hit which field (name, description, elements …). */
export const Matched = list(obj({ word: str, field: str }));
/** `{kind: "mega-menu", count: 31}` — the kinds of the focus element, most common first. */
export const KindCounts = list(obj({ kind: str, count: int }));

/** A site, page or repo in the catalog. */
export const ResourceHit = obj({
  id: str,
  name: str,
  url: str,
  kind: { type: "string", enum: ["site", "page", "repo"] },
  summary: str,
  flags: strs,
  pages: int,
  matched: Matched,
});

/** A component, gallery example or docs page mapped inside an entry. */
export const ComponentHit = obj({
  id: str,
  name: str,
  registry: str,
  host: str,
  description: nstr,
  access: { type: "string", enum: ACCESS },
  granularity: str,
  type: nstr,
  url: nstr,
  elements: strs,
  kinds: strs,
  stacks: strs,
  also: strs,
  matched: Matched,
});

/** One line of list_pages: a mapped page (name, url, id for code items) or a raw sitemap url. */
export const PageHit = obj({ name: nstr, url: nstr, id: nstr, access: nenum(ACCESS), kinds: strs });

/** get_resource for a catalog entry. */
export const Resource = obj({
  id: str,
  name: str,
  summary: str,
  about: nstr,
  url: str,
  domain: str,
  kind: { type: "string", enum: ["site", "page", "repo"] },
  categories: strs,
  capabilities: strs,
  reachable: { type: ["boolean", "null"] },
  unreachable_reason: nstr,
  registry: nullable(obj({ url: str, items: nint, gated: bool })),
  llms_url: nstr,
  llms_full_url: nstr,
  clone: nstr,
  local_copy: nstr,
  mapped: nullable(obj({ code: int, gated: int, gallery: int, docs: int, total: int })),
  labels: strs,
  origins: strs,
});

/** get_resource for a component id: tags, url and how to get the code. */
export const Component = obj({
  id: str,
  name: str,
  registry: str,
  registry_name: str,
  granularity: str,
  description: nstr,
  access: { type: "string", enum: ACCESS },
  elements: strs,
  kinds: list(obj({ element: str, kinds: strs })),
  type: nstr,
  url: nstr,
  stacks: strs,
  examples: strs,
  local: bool,
  install_url: nstr,
  install_command: nstr,
});

/** get_component: what the source is, where it comes from, and which window of it the text holds. */
export const ComponentSource = obj({
  id: nstr,
  registry: str,
  name: nstr,
  status: { type: "string", enum: ["ok", "page", "gated", "no-registry", "unavailable"] },
  type: nstr,
  dependencies: strs,
  devDependencies: strs,
  registryDependencies: strs,
  install_url: nstr,
  install_command: nstr,
  page_url: nstr,
  source: nstr,
  stack: nstr,
  stacks: strs,
  files: list(obj({ path: str, chars: int })),
  chars: int,
  offset: int,
  next_offset: nextOffset,
  examples: list(obj({ name: str, chars: int, shown: int })),
  examples_omitted: strs,
});

/** get_content: which document, which mode, which sections the text holds. */
export const ContentAnswer = obj({
  ref: str,
  name: str,
  source: nstr,
  live: bool,
  mode: { type: "string", enum: ["whole", "outline", "query", "section", "none"] },
  chars: int,
  sections: int,
  query: nstr,
  hits: list(obj({ n: int, title: str, chars: int })),
  total_hits: nint,
  truncated: bool,
  offset: int,
  next_offset: nextOffset,
});

/** get_install_command: one shadcn command plus what it pulls in and what it could not include. */
export const InstallPlan = obj({
  package_manager: { type: "string", enum: ["npx", "pnpm", "bunx", "yarn"] },
  command: nstr,
  urls: strs,
  items: list(obj({ id: nstr, registry: str, name: str, url: str, type: nstr, from: { type: "string", enum: ["corpus", "live"] } })),
  dependencies: strs,
  devDependencies: strs,
  registryDependencies: strs,
  skipped: list(
    obj({
      input: str,
      reason: { type: "string", enum: ["page", "gated", "unknown", "no-registry", "unavailable"] },
      id: nstr,
      url: nstr,
      closest: strs,
    }),
  ),
});

const filters = (names) => obj(Object.fromEntries(names.map((n) => [n, nstr])));
const withDefs = ($defs, properties) => ({ ...obj(properties), $defs });

/** One outputSchema per tool. */
export const OUTPUT_SCHEMAS = {
  search_resources: withDefs({ ResourceHit, ComponentHit }, {
    query: str,
    filters: filters(["element", "variant", "category", "kind"]),
    total: int,
    counts: obj({ resources: int, components: int, gallery: int, docs: int }),
    focus: nullable(obj({ element: str, components: int, registries: int, gated: int, gallery: int, docs: int, resources: int, kinds: KindCounts })),
    resources: list(ref("ResourceHit")),
    components: list(ref("ComponentHit")),
    gallery: list(ref("ComponentHit")),
    docs: list(ref("ComponentHit")),
    offset: int,
    next_offset: nextOffset,
  }),
  search_components: obj({
    query: str,
    filters: filters(["element", "variant", "registry", "access", "stack"]),
    total: int,
    focus: nstr,
    kinds: KindCounts,
    hits: list(ComponentHit),
    offset: int,
    next_offset: nextOffset,
  }),
  list_pages: obj({
    ref: str,
    host: str,
    source: { type: "string", enum: ["items", "sitemap"] },
    total: int,
    matches: int,
    kinds: KindCounts,
    prefixes: list(obj({ prefix: str, count: int })),
    pages: list(PageHit),
    offset: int,
    next_offset: nextOffset,
  }),
  get_resource: obj({ resource: nullable(Resource), component: nullable(Component) }),
  list_components: obj({
    registry: obj({ id: str, name: str, index_url: nstr }),
    source: nenum(["local", "live"]),
    total: int,
    matches: int,
    filters: filters(["query", "type"]),
    install_base: nstr,
    components: list(obj({ name: str, title: nstr, type: nstr, id: nstr, url: nstr })),
    offset: int,
    next_offset: nextOffset,
    note: nstr,
  }),
  get_content: ContentAnswer,
  get_component: ComponentSource,
  get_install_command: InstallPlan,
};
