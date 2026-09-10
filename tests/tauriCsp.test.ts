import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type TauriConfig = {
  app?: {
    security?: {
      csp?: Record<string, string> | null;
      devCsp?: Record<string, string> | string | null;
    };
  };
};

const configPath = new URL("../src-tauri/tauri.conf.json", import.meta.url);

async function loadSecurityConfig() {
  const config = JSON.parse(
    await readFile(configPath, "utf8"),
  ) as TauriConfig;
  return config.app?.security;
}

test("production CSP is enabled while development remains Vite-compatible", async () => {
  const security = await loadSecurityConfig();

  assert.ok(security?.csp && typeof security.csp === "object");
  assert.equal(security.devCsp, null);
});

test("production CSP keeps executable content local and blocks unsafe fallbacks", async () => {
  const security = await loadSecurityConfig();
  const csp = security?.csp;

  assert.ok(csp && typeof csp === "object");
  assert.equal(csp["script-src"], "'self'");
  assert.equal(csp["object-src"], "'none'");
  assert.equal(csp["base-uri"], "'none'");
  assert.equal(csp["frame-ancestors"], "'none'");
  assert.equal(csp["form-action"], "'none'");

  const policy = Object.values(csp).join(" ");
  assert.doesNotMatch(policy, /(^|\s)\*(\s|$)/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.doesNotMatch(csp["script-src"], /https?:/);
});

test("production CSP permits only the app bridge and known provider media hosts", async () => {
  const security = await loadSecurityConfig();
  const csp = security?.csp;

  assert.ok(csp && typeof csp === "object");

  for (const source of ["ipc:", "http://ipc.localhost"]) {
    assert.match(csp["connect-src"], new RegExp(source.replaceAll(".", "\\.")));
  }

  const providerSources = [
    "https://*.qq.com",
    "https://*.qqmusic.qq.com",
    "https://*.music.126.net",
    "https://*.scdn.co",
    "https://*.spotifycdn.com",
  ];

  for (const source of providerSources) {
    assert.ok(csp["img-src"].includes(source));
    assert.ok(csp["media-src"].includes(source));
    assert.ok(csp["connect-src"].includes(source));
  }

  assert.ok(csp["img-src"].includes("https://*.qlogo.cn"));
  assert.ok(csp["img-src"].includes("data:"));
  assert.ok(csp["worker-src"].includes("blob:"));
});
