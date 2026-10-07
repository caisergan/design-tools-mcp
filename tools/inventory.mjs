#!/usr/bin/env bun
// Build catalog/inventory.json — the harvest ledger for our component-library sources.
// Answers per site: what is it, is it paid, does it ship an MCP, what did we already pull,
// what is left, and *why* the rest could not be pulled (with HTTP codes).
// Usage: bun tools/inventory.mjs [--sample=12] [--no-live]
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FILE, OUT, loadJSON, saveJSON, repoParts, resolveItemBase } from "./lib.mjs";
import { loadItems } from "./build.mjs";

const SAMPLE = Number((process.argv.find((a) => a.startsWith("--sample=")) || "").split("=")[1] || 12);
const LIVE = !process.argv.includes("--no-live");
const UA = "Mozilla/5.0 (compatible; design-tools-inventory/1.0)";

// taxonomy category ids (catalog/taxonomy.json)
const SCOPE = ["color-effects", "icons", "fonts", "motion", "sections"];
const inScope = (i) => i.categories.some((c) => SCOPE.includes(c));

const catalog = loadJSON(FILE.catalog);
const probe = loadJSON(FILE.probe, { items: {} });
const manifest = existsSync(FILE.manifest) ? readFileSync(FILE.manifest, "utf8") : "";
/** repos live under corpus/repos/<owner>__<repo>, sites under corpus/sites/<domain> */
const corpusOf = (it) => {
  if (it.kind === "repo") {
    const rp = repoParts(it.url);
    return rp ? join(FILE.corpus, "repos", `${rp.owner}__${rp.repo}`) : join(FILE.corpus, "repos", it.domain);
  }
  return join(FILE.corpus, "sites", it.domain);
};
const idOf = (it) => (it.kind === "repo" ? `${repoParts(it.url)?.owner}/${repoParts(it.url)?.repo}` : it.domain);
const registryOf = (i) => i.probe && (i.probe.registry || i.probe.registry_index || i.probe.registry_root);

// ------------------------------------------------------------------ helpers

const listFiles = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).map((e) => e.name) : []);
const countFiles = (dir) => {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
  return n;
};

function classifyType(it) {
  if (it.kind === "repo") return "repo";
  if (registryOf(it)) return "registry";
  const c = it.categories;
  if (c.includes("icons")) return it.kind === "repo" ? "icon-repo" : "icon-set";
  if (c.includes("fonts")) return "font-foundry";
  if (c.includes("motion")) return "motion-library";
  if (c.includes("sections")) return "section-gallery";
  if (c.includes("color-effects")) return "color-tool";
  if (it.probe?.llms) return "docs-site";
  return it.probe?.sitemap ? "gallery" : "gallery-no-sitemap";
}

/** What "harvesting" even means for this kind of source. */
const HARVEST_MODEL = {
  registry: "shadcn registry → item JSON taşır, kaynak kod doğrudan iner",
  repo: "git/raw → README + SKILL.md iner; tam repo için clone gerekir",
  "icon-repo": "GitHub'da ikon kaynakları var; npm paketi veya repo clone ile tamamı alınır",
  "icon-set": "site üzerinden arama/indirme; toplu indirme yok",
  "font-foundry": "font dosyaları lisanslı; indirme şartları foundry'ye göre",
  "motion-library": "kod örnekleri sayfada; registry yoksa HTML'den çıkarım gerekir",
  "section-gallery": "görsel galeri; her öğe bir ekran görüntüsü + link",
  gallery: "görsel galeri; sitemap'tan sayfa listesi + screenshot",
  "gallery-no-sitemap": "görsel galeri, sitemap yok; keşif manuel/pagination",
  "color-tool": "üreteç/araç; çıktı kullanıcı üretimi (gradient vb.)",
  "docs-site": "llms.txt ile metin; kod ancak ilgili sayfalardan",
};

function mcpOf(it, llmsText) {
  const hits = [];
  const clean = (u) => u.replace(/[),.;:\]]+$/, "").replace(/\?.*$/, "");
  if (/\/mcp\b/.test(it.url)) hits.push({ url: it.url, evidence: "katalog URL'i" });
  if (it.probe?.mcp) hits.push({ url: it.url, evidence: "probe" });
  for (const line of (llmsText || "").split("\n")) {
    const urls = [...line.matchAll(/https?:\/\/[^\s)"'\]]+/g)].map((m) => clean(m[0]));
    const mcpUrl = urls.find((u) => /\/mcp\b|\/mcp\.md$|mcp\./i.test(u));
    if (mcpUrl && /\bmcp\b/i.test(line)) {
      hits.push({ url: mcpUrl, evidence: `llms.txt: ${line.trim().slice(0, 120)}` });
      break;
    }
  }
  return hits;
}

function pricingOf(it, text) {
  const ev = [];
  const reg = registryOf(it);
  if (reg?.item_status === 401 || reg?.item_status === 403)
    ev.push({ signal: "gated", detail: `registry item ilk istekte HTTP ${reg.item_status}`, source: reg.url, confidence: "high" });
  for (const [re, tag] of [
    [/license key|api[_ ]key|unauthorized/i, "key-required"],
    [/one-time payment|paid plan|\$\s?\d+|pricing/i, "pricing-page"],
    [/\bfree\b|open[- ]source|\bMIT\b|free and open/i, "free-signal"],
    [/unlimited on a paid plan|upgrade|pro plan/i, "upsell"],
  ]) {
    const m = new RegExp(`.{0,80}${re.source}.{0,80}`, "i").exec(text || "");
    if (m) ev.push({ signal: tag, detail: m[0].replace(/\s+/g, " ").trim(), source: "llms.txt", confidence: "medium" });
  }
  const model = ev.some((e) => e.signal === "gated" && e.confidence === "high")
    ? "freemium"
    : ev.some((e) => e.signal === "free-signal")
      ? "free"
      : ev.some((e) => ["pricing-page", "upsell"].includes(e.signal))
        ? "freemium"
        : "unknown";
  return { model, evidence: ev, confidence: ev.some((e) => e.confidence === "high") ? "high" : ev.length ? "medium" : "low" };
}

/** Sample the items we are missing and record the exact HTTP reason. */
async function sampleFailures(it) {
  const reg = registryOf(it);
  const dir = corpusOf(it);
  const index = existsSync(join(dir, "registry.json")) ? loadJSON(join(dir, "registry.json")) : null;
  if (!reg || !index) return { sampled: 0, barriers: [] };
  const entries = (Array.isArray(index) ? index : index.items || []).filter((e) => e?.name);
  const haveNames = new Set(listFiles(join(dir, "items")).map((f) => f.replace(/\.json$/, "")));
  const missing = entries.filter((e) => !haveNames.has(String(e.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 72)));
  const pick = [];
  const step = Math.max(1, Math.floor(missing.length / SAMPLE));
  for (let i = 0; i < missing.length && pick.length < SAMPLE; i += step) pick.push(missing[i]);
  const found = await resolveItemBase(reg.url, pick[0]?.name || "x", { ua: UA }).catch(() => null);
  if (!found || found.gated) {
    const code = found?.gated || reg.item_status;
    return {
      sampled: 0,
      barriers: code
        ? [{ code: `http_${code}`, count: missing.length, sample: `${found?.base || reg.url}/<item>.json`, why: "item JSON lisans anahtarı istiyor" }]
        : [{ code: "no_item_endpoint", count: missing.length, sample: reg.url, why: "item JSON hiçbir şablonda servis edilmiyor" }],
    };
  }
  const stats = new Map();
  for (const e of pick) {
    let code = "network_error";
    try {
      const r = await fetch(`${found.base}/${encodeURIComponent(e.name)}.json`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10000) });
      code = r.status === 200 ? (/json/i.test(r.headers.get("content-type") || "") ? "200_not_cached" : "200_html") : `http_${r.status}`;
    } catch (err) {
      code = err?.name === "TimeoutError" ? "timeout" : "network_error";
    }
    if (!stats.has(code)) stats.set(code, { count: 0, sample: `${found.base}/${e.name}.json` });
    stats.get(code).count++;
  }
  const scale = missing.length / Math.max(pick.length, 1);
  const WHY = {
    http_401: "lisans anahtarı gerekiyor (ücretli içerik)",
    http_403: "erişim engelli (kayıt/lisans)",
    http_404: "bu isimde item yok (indeks ile item uçları tutarsız)",
    http_429: "hız sınırı — yavaşlatmak gerekir",
    timeout: "zaman aşımı — tekrar denenebilir",
    network_error: "ağ hatası — tekrar denenebilir",
    "200_not_cached": "aslında çekilebilir, sadece item limitine takıldı",
    "200_html": "item ucu HTML döndürüyor (JSON değil)",
  };
  return {
    sampled: pick.length,
    base: found.base,
    barriers: [...stats].map(([code, v]) => ({ code, count: Math.round(v.count * scale), sample: v.sample, why: WHY[code] || "bilinmiyor" })),
  };
}

async function sitemapPages(url) {
  if (!LIVE || !url) return null;
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const body = await res.text();
    let n = (body.match(/<loc>/g) || []).length;
    if (n < 3 && /sitemapindex/i.test(body)) {
      const sub = (/<loc>([^<]+)<\/loc>/.exec(body) || [])[1];
      const r2 = sub && (await fetch(sub, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(12000) }).catch(() => null));
      if (r2?.ok) n = ((await r2.text()).match(/<loc>/g) || []).length;
    }
    return n;
  } catch {
    return null;
  }
}

/** When llms.txt says nothing about money, look at the site's own pricing page. */
async function pricingLive(it) {
  const origin = new URL(it.url).origin;
  for (const path of ["/pricing", "/plans", "/pro", ""]) {
    let res;
    try {
      res = await fetch(origin + path, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10000), redirect: "follow" });
    } catch {
      continue;
    }
    if (!res.ok) continue;
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    const hasPlanPrice = /(\$|€|£)\s?\d[\d.,]*\s*(?:\/|per\s)\s*(?:mo|month|user|seat|year)|\bper month\b|\bper user\b|\bone-time payment\b|\bsubscription\b/i.test(text);
    const zeroPrice = /(\$|€|£)\s?0\b/.test(text);
    const free = /\bfree\b|no credit card|open source|MIT license|free forever|start for free/i.test(text);
    const amount = (text.match(/(\$|€|£)\s?\d[\d.,]*\s*(?:\/|per\s)\s*(?:mo|month|user|seat|year)/i) || [])[0];
    if (!amount) continue; // gerçek fiyat yoksa "freemium" demiyoruz
    const ev = [
      { signal: "live-pricing-page", detail: `${origin + path} → plan fiyatı: ${amount || "var"}`, source: origin + path, confidence: "medium" },
      ...(free || zeroPrice ? [{ signal: "free-signal", detail: `${origin + path} → ücretsiz plan ifadesi var`, source: origin + path, confidence: "medium" }] : []),
    ];
    return { model: free || zeroPrice ? "freemium" : "paid", evidence: ev, confidence: "medium" };
  }
  return null;
}

/** Repos don't have a pricing page — their license file is the answer. */
async function repoLicense(it) {
  const rp = repoParts(it.url);
  if (!rp) return null;
  for (const f of ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"]) {
    let res;
    try {
      res = await fetch(`https://raw.githubusercontent.com/${rp.owner}/${rp.repo}/HEAD/${f}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10000) });
    } catch {
      continue;
    }
    if (!res.ok) continue;
    const t = (await res.text()).slice(0, 6000);
    const kind = /MIT License|Permission is hereby granted, free of charge/i.test(t)
      ? "MIT"
      : /Apache License/i.test(t)
        ? "Apache-2.0"
        : /GNU (AFFERO )?GENERAL PUBLIC LICENSE/i.test(t)
          ? "GPL"
          : /BSD/i.test(t)
            ? "BSD"
            : "other";
    return { kind, source: `https://github.com/${rp.owner}/${rp.repo}/blob/HEAD/${f}` };
  }
  const readme = join(corpusOf(it), "README.md");
  if (existsSync(readme)) {
    const t = readFileSync(readme, "utf8").slice(0, 5000);
    const kind = /\bMIT\b/i.test(t) ? "MIT" : /Apache/i.test(t) ? "Apache-2.0" : /GPL/i.test(t) ? "GPL" : null;
    if (kind) return { kind, source: `${it.url} (README)` };
  }
  return null;
}

/** Fill an empty description from the site's own meta/title. */
async function describeLive(it) {
  try {
    const res = await fetch(it.url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10000), redirect: "follow" });
    if (!res.ok) return "";
    const html = (await res.text()).slice(0, 200000);
    const meta = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{20,300})["']/i.exec(html)
      || /<meta[^>]+content=["']([^"']{20,300})["'][^>]+name=["']description["']/i.exec(html)
      || /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{20,300})["']/i.exec(html);
    if (meta) return meta[1].replace(/\s+/g, " ").trim();
    const title = /<title[^>]*>([^<]{5,160})<\/title>/i.exec(html);
    return title ? title[1].replace(/\s+/g, " ").trim() : "";
  } catch {
    return "";
  }
}

// ------------------------------------------------------------------ build

const scope = catalog.items.filter(inScope);
const sites = [];
for (const it of scope) {
  const dir = corpusOf(it);
  const reg = registryOf(it);
  const type = classifyType(it);
  const llmsPath = join(dir, "llms.txt");
  const llmsText = existsSync(llmsPath) ? readFileSync(llmsPath, "utf8") : "";
  const itemsListed = reg?.items ?? 0;
  const itemsFetched = countFiles(join(dir, "items"));
  const componentSrc = countFiles(join(dir, "src"));
  const localFiles = countFiles(dir);

  const barriers = [];
  if (reg && LIVE && itemsListed > itemsFetched) {
    const sample = await sampleFailures(it);
    for (const b of sample.barriers) barriers.push(b);
  }
  if (type.includes("gallery")) barriers.push({ code: "image_only", count: it.probe?.sitemap ? await sitemapPages(it.probe.sitemap.url) : null, sample: it.url, why: "içerik ekran görüntüsü; kod yok — browser/vision gerekir" });
  if (it.kind === "repo") barriers.push({ code: "partial_repo", count: null, sample: it.url, why: "sadece README/SKILL indi; tam repo clone edilmedi" });

  const pullable = !!reg || !!it.probe?.llms || it.kind === "repo";
  const status = reg
    ? itemsFetched === 0
      ? "none"
      : itemsListed && itemsFetched < itemsListed
        ? "partial"
        : "full"
    : pullable
      ? localFiles
        ? "full"
        : "none"
      : "not_applicable";

  sites.push({
    id: idOf(it),
    name: it.name,
    url: it.url,
    domain: it.domain,
    categories: it.categories.filter((c) => SCOPE.includes(c)),
    all_categories: it.categories,
    mentions: it.mentions,
    what_it_is: it.desc || "",
    type,
    harvest_model: HARVEST_MODEL[type] || "bilinmiyor",
    access: {
      llms_txt: it.probe?.llms ? { url: it.probe.llms.url, bytes: it.probe.llms.bytes, links: it.probe.llms.links, in_corpus: existsSync(llmsPath) } : null,
      llms_full: it.probe?.llms_full ? { url: it.probe.llms_full.url, bytes: it.probe.llms_full.bytes } : null,
      registry: reg ? { url: reg.url, items_listed: reg.items ?? null, first_item_status: reg.item_status ?? null, local_index: existsSync(join(dir, "registry.json")) } : null,
      mcp: mcpOf(it, llmsText),
      skill_index: it.probe?.skill_index ? { url: it.probe.skill_index.url } : null,
      sitemap: it.probe?.sitemap ? { url: it.probe.sitemap.url } : null,
      repo: it.kind === "repo" ? { clone: `git clone ${it.url}.git`, local: existsSync(join(dir, "README.md")) } : null,
    },
    pricing: pricingOf(it, llmsText),
    harvest: {
      status,
      files_local: localFiles,
      component_src: componentSrc,
      items_listed: itemsListed || null,
      items_fetched: itemsFetched || null,
      items_missing: reg && itemsListed ? Math.max(0, itemsListed - itemsFetched) : null,
      dirs: existsSync(dir) ? [dir.replace(FILE.corpus + "/", "corpus/")] : [],
      barriers,
    },
    risks: [],
    next_actions: [],
    keep: [
      "kaynak URL + ilk görülme tarihi + kaynak postlar",
      ...(it.probe?.llms ? ["llms.txt anlık görüntüsü (sağlayıcı değişimini yakalamak için)"] : []),
      ...(it.probe?.sitemap ? ["sitemap anlık görüntüsü (yeni öğeleri diff'lemek için)"] : []),
      ...(reg ? ["registry.json item adları listesi (yeni item'ları diff'lemek için)"] : []),
      ...(it.kind === "repo" ? ["commit hash (güncelleme takibi)"] : []),
      ...(pricingOf(it, llmsText).model !== "free" ? ["lisans/plan notu (satın alma kararı)"] : []),
    ],
    log: [
      { at: catalog.generated_at?.slice(0, 10), event: "probe", note: `llms=${!!it.probe?.llms} registry=${!!reg} mcp=${!!mcpOf(it, llmsText).length}` },
      ...(localFiles ? [{ at: new Date().toISOString().slice(0, 10), event: "harvest", note: `${localFiles} dosya, ${componentSrc} komponent kaynağı` }] : []),
    ],
  });
}
// ------------------------------------------------------------------ derived advice

function advice(site, it) {
  const risks = [];
  const actions = [];
  const t = site.type;
  const b = site.harvest.barriers.map((x) => x.code);

  if (t === "registry") {
    risks.push("indeks isimleri ile item uçları tutarsız olabilir (404)");
    risks.push("sağlayıcı shadcn registry şemasını güncellerse resolver şablonları değişir");
    if (b.some((c) => /^http_40[13]$|no_item_endpoint/.test(c))) {
      risks.push("lisans anahtarı gerektiren kısım anonim istekte 401/403 döner");
      actions.push("ücretli kısım için lisans anahtarı al; fetch'e Authorization başlığı eklenmeli (henüz yok)");
    }
    if (b.includes("200_not_cached")) actions.push(`kalan ${site.harvest.items_missing} item limit yüzünden inmedi: bun tools/fetch.mjs --registries --items=2000 --only=${site.domain}`);
    if (b.includes("timeout") || b.includes("network_error")) actions.push("başarısız istekler için tekrar denemesi (retry) ile yeniden çalıştır");
    risks.push("boşluk varsa item adı eşlemesi değişmiş olabilir; probe.json tazelenmeli");
  }
  if (t.includes("gallery")) {
    risks.push("Cloudflare / 429 engeli çıkabilir; nazik hız ve başlıklar gerekir");
    risks.push("JS-shell ise ham HTML işe yaramaz, headless render şart");
    risks.push("görseller başka sitelerin/fotoğrafçıların; yayınlanamaz, kişisel indeks olarak tutulmalı");
    risks.push("selector bakımı: Framer/Next deploy'larında markup değişir");
    const pages = site.harvest.barriers.find((x) => x.code === "image_only")?.count;
    actions.push(pages ? `screenshot pipeline: ${pages} sayfa × (tam sayfa + kart görseli), sonra vision ile etiketleme` : "sitemap yok: sayfalama/keşif yazılmalı, yoksa manuel liste");
  }
  if (t === "font-foundry") {
    risks.push("font dosyaları telifli; indirme çoğu foundry'de yasak/şartlı");
    risks.push("OFL lisanslı olanlar serbest, diğerleri yalnızca referans");
    actions.push("font adı + lisans + indirme linkini envanterde tut; dosya indirme");
  }
  if (t === "icon-repo" || t === "repo") {
    risks.push("yalnızca README/SKILL indi; repo geçmişi ve paket içeriği yok");
    actions.push("tam klon + npm paket içeriğini corpus'a al (ikon/komponent setinin tamamı için)");
  }
  if (t === "icon-set") {
    risks.push("toplu indirme ucu yok; arama/indirme manuel veya lisanslı");
    actions.push("pack sağlıyorsa npm paketini dene");
  }
  if (t === "motion-library" || t === "docs-site") {
    risks.push("kod örnekleri sayfa içinde gömülü; sayfa yapısı değişirse çıkarım kırılır");
    actions.push("llms.txt bağlantılarını takip edip örnek sayfalarını corpus'a ekle");
  }
  if (site.access.mcp.length) actions.push(`kendi MCP'si var → omp'ye bağla: ${site.access.mcp[0].url}`);
  if (site.access.llms_txt && !site.access.llms_txt.in_corpus) actions.push("llms.txt'yi indir (bun tools/fetch.mjs --llms)");
  if (!actions.length) actions.push("şimdilik yapılacak yok");
  return { risks, actions };
}

// ------------------------------------------------------------------ assemble

for (const site of sites) {
  const it = scope.find((i) => idOf(i) === site.id);
  if (LIVE && site.type === "repo") {
    const lic = await repoLicense(it);
    site.license = lic ? lic.kind : null;
    site.pricing = {
      model: lic && ["MIT", "Apache-2.0", "BSD"].includes(lic.kind) ? "free" : "unknown",
      evidence: lic
        ? [{ signal: "repo-license", detail: `${lic.kind} lisanslı repo`, source: lic.source, confidence: "medium" }]
        : [{ signal: "no-license-found", detail: "LICENSE dosyası bulunamadı", source: it.url, confidence: "low" }],
      confidence: lic ? "medium" : "low",
    };
  } else if (LIVE && (site.pricing.model === "unknown" || site.pricing.confidence === "low")) {
    const live = await pricingLive(it);
    if (live) site.pricing = { ...live, evidence: [...site.pricing.evidence, ...live.evidence] };
    else site.pricing.evidence.push({ signal: "no-pricing-page", detail: "site üzerinde fiyat sayfası/ifadesi bulunamadı", source: site.url, confidence: "low" });
  }
  if (LIVE && !site.what_it_is) {
    const d = await describeLive(it);
    if (d) site.what_it_is = d;
  }
  const { risks, actions } = advice(site, it);
  site.risks = risks;
  site.next_actions = actions;
  const gated = site.harvest.barriers.find((b) => b.code === "http_401" || b.code === "http_403");
  if (gated && site.pricing.model !== "freemium") {
    site.pricing.model = site.harvest.component_src > 0 ? "freemium" : "paid";
    site.pricing.confidence = "high";
    site.pricing.evidence.unshift({
      signal: "gated",
      detail: `${gated.count} item HTTP ${gated.code.slice(5)} döndü (${gated.sample})`,
      source: "ölçüm",
      confidence: "high",
    });
  }
  if (site.access.registry && site.harvest.items_missing) {
    site.log.push({ at: new Date().toISOString().slice(0, 10), event: "gap", note: `${site.harvest.items_missing} item eksik: ${site.harvest.barriers.map((b) => b.code).join(", ") || "sebep kaydedilmedi"}` });
  }
}

const unharvestable = sites
  .flatMap((s) => s.harvest.barriers.filter((b) => !["200_not_cached", "partial_repo"].includes(b.code)).map((b) => ({ site: s.id, url: s.url, type: s.type, code: b.code, count: b.count, sample: b.sample, why: b.why, fix: s.next_actions[0] })))
  .sort((a, b) => (b.count || 0) - (a.count || 0));

const harvestIndex = {};
for (const s of sites) {
  if (!s.harvest.files_local) continue;
  harvestIndex[s.id] = {
    kind: s.type,
    dir: s.harvest.dirs[0],
    files: s.harvest.files_local,
    component_src: s.harvest.component_src,
    items: s.harvest.items_fetched,
    llms: !!s.access.llms_txt?.in_corpus,
  };
}

const doc = {
  schema: "design-tools/inventory@1",
  generated_at: new Date().toISOString(),
  purpose:
    "Component kütüphanemizin kaynak defteri: her site için ne olduğu, ücretli mi, kendi MCP'si var mı, ne kadarını çektiğimiz ve çekemediğimiz kısmın HTTP gerekçesi. Yeni hasat turlarında önce bunu oku, sonra next_actions'ı uygula.",
  scope: {
    categories: SCOPE,
    site_count: sites.length,
    source_files: ["catalog/sources/*.json"],
    probe: { generated_at: probe.generated_at, sampled_items_per_registry: SAMPLE, live_probe: LIVE },
  },
  legend: {
    "type": Object.keys(HARVEST_MODEL),
    "harvest.status": {
      full: "erişilebilen her şey yerelde",
      partial: "bir kısmı indi, kalanı barriers[] içinde gerekçeli",
      none: "hiç inmedi",
      not_applicable: "kaynak kod içermiyor (görsel galeri / araç)",
    },
    "harvest.barriers[].code": {
      http_401: "lisans/kimlik gerekiyor",
      http_403: "engelli",
      http_404: "indekste var, uçta yok",
      http_429: "hız sınırı",
      timeout: "zaman aşımı (tekrar denenebilir)",
      network_error: "ağ hatası (tekrar denenebilir)",
      "200_not_cached": "çekilebilir, item limitine takıldı",
      image_only: "içerik görüntü, kod değil",
      partial_repo: "README indi, repo klonlanmadı",
      no_item_endpoint: "item JSON public değil",
    },
    "pricing.model": ["free", "freemium", "paid", "unknown"],
    "pricing.confidence": ["high (ölçüm)", "medium (metin kanıtı)", "low (varsayım)"],
  },
  totals: {
    sites: sites.length,
    by_type: sites.reduce((a, s) => ({ ...a, [s.type]: (a[s.type] || 0) + 1 }), {}),
    by_harvest_status: sites.reduce((a, s) => ({ ...a, [s.harvest.status]: (a[s.harvest.status] || 0) + 1 }), {}),
    with_registry: sites.filter((s) => s.access.registry).length,
    with_mcp: sites.filter((s) => s.access.mcp.length).length,
    with_llms_txt: sites.filter((s) => s.access.llms_txt).length,
    component_src_total: sites.reduce((n, s) => n + s.harvest.component_src, 0),
    items_listed_total: sites.reduce((n, s) => n + (s.harvest.items_listed || 0), 0),
    items_missing_total: sites.reduce((n, s) => n + (s.harvest.items_missing || 0), 0),
  },
  sites,
  unharvestable,
  harvest_index: harvestIndex,
};

saveJSON(join(OUT, "inventory.json"), doc);

if (process.argv.includes("--snapshot")) {
  const stamp = new Date().toISOString().slice(0, 10);
  const snap = join(OUT, "snapshots", `inventory-${stamp}.json`);
  saveJSON(snap, doc);
  console.log(`snapshot → ${snap.replace(process.env.HOME, "~")}`);
}

const t = doc.totals;
console.log(`\ninventory.json → ${join(OUT, "inventory.json")}`);
console.log(`tip: ${Object.entries(t.by_type).map(([k, v]) => `${k}:${v}`).join(" · ")}`);
console.log(`hasat: ${Object.entries(t.by_harvest_status).map(([k, v]) => `${k}:${v}`).join(" · ")}`);
console.log(`registry=${t.with_registry} mcp=${t.with_mcp} llms=${t.with_llms_txt} · komponent kaynağı=${t.component_src_total} · eksik item=${t.items_missing_total}`);
console.log(`çekilemeyen başlıkları: ${unharvestable.length}`);
for (const u of unharvestable.slice(0, 12)) console.log(`  ${String(u.count ?? "?").padStart(5)}  ${u.code.padEnd(18)} ${u.site.padEnd(28)} ${u.why}`);
export { doc };
