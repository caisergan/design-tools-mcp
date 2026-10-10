#!/usr/bin/env bun
import { test, expect } from "bun:test";
import { accessVerdict } from "./registry-access.mjs";

test("a registry item JSON is free, 401/402/403 gated, anything else retried", () => {
  expect(accessVerdict({ status: 200, text: '{"name":"c-button-7","type":"registry:block"}' })).toBe("code");
  expect(accessVerdict({ status: 401, text: "" })).toBe("gated");
  expect(accessVerdict({ status: 402 })).toBe("gated");
  expect(accessVerdict({ status: 403 })).toBe("gated");
  expect(accessVerdict({ status: 200, text: "<!doctype html><title>Pricing</title>" })).toBeNull(); // a paywall page
  expect(accessVerdict({ status: 200, text: '{"error":"upgrade"}' })).toBeNull();
  expect(accessVerdict({ status: 404 })).toBeNull();
  expect(accessVerdict({ status: 0, error: "timeout" })).toBeNull();
});
