#!/usr/bin/env bun
// Source labels → taxonomy category ids (MCP-PLAN 2.3). Pure: no catalog files read.
import { test, expect } from "bun:test";
import { categorize, CATEGORY_IDS } from "./categorize.mjs";
import { TAXONOMY } from "./tag.mjs";

const entry = (categories, name = "x", desc = "", labels = []) => ({ name, desc, categories, labels });

test("every from_label belongs to exactly one category", () => {
  const all = TAXONOMY.categories.flatMap((c) => c.from_labels);
  expect(new Set(all).size).toBe(all.length);
  expect(CATEGORY_IDS.length).toBe(15);
});

test("harvest labels map to ids in source order, at most 2", () => {
  expect(categorize(entry(["UI komponent & kit"])).categories).toEqual(["components"]);
  expect(categorize(entry(["shadcn ecosystem · Boilerplates / Templates"])).categories).toEqual(["templates"]);
  expect(categorize(entry(["Motion & animasyon", "UI komponent & kit", "İkon"])).categories).toEqual(["motion", "components"]);
  expect(categorize(entry(["Genel web araçları", "Mac & creator uygulamaları"])).categories).toEqual(["dev-ai-tools"]);
});

test("report sections and the GitHub label are not categories", () => {
  const r = categorize(entry(["Tek site paylaşan postlar", "GitHub repoları (postlarda paylaşılan)"], "acme/thing", "A proxy checker"));
  expect(r).toEqual({ categories: ["dev-ai-tools"], via: "default", unknown: [] });
  expect(categorize(entry(["Diğer", "Font & tipografi"])).categories).toEqual(["fonts"]);
});

test("an entry with only the GitHub label is classified from its text", () => {
  const gh = ["GitHub repoları (postlarda paylaşılan)"];
  expect(categorize(entry(gh, "Nutlope/hallmark", "Anti-AI-slop design skill for Claude Code, Cursor, and Codex.")).categories).toEqual(["design-rules"]);
  // a skill that has nothing to do with design is not a design rule
  expect(categorize(entry(gh, "blader/humanizer", "Agent skill that removes signs of AI-generated writing from text")).categories).toEqual(["dev-ai-tools"]);
  expect(categorize(entry(gh, "tailwindlabs/heroicons", "A set of free MIT-licensed high-quality SVG icons for UI development.")).categories).toEqual(["icons"]);
  expect(categorize(entry(gh, "greensock/gsap", "GSAP, a JavaScript animation library")).categories).toEqual(["motion"]);
  // 'IDE extension' is not a design-tools plugin
  expect(categorize(entry(gh, "cline/cline", "Autonomous coding agent as an SDK, IDE extension, or CLI assistant.")).categories).toEqual(["dev-ai-tools"]);
});

test("labels no category claims are reported, not dropped silently", () => {
  expect(categorize(entry(["Brand new label"])).unknown).toEqual(["Brand new label"]);
});
