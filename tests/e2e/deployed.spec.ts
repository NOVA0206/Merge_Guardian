import { expect, test } from "@playwright/test";

/**
 * Deployment-safe checks: read-only, no mocks. They run against the local production build AND against any
 * Vercel preview/production URL (PLAYWRIGHT_BASE_URL). They prove the deployed product answers correctly and fails closed.
 */
test.describe("@deployed public surface", () => {
  test("@deployed homepage renders without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Merge only what you have verified");
    await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("@deployed health endpoint reports status and never leaks secrets", async ({ request }) => {
    const res = await request.get("/api/health");
    expect([200, 503]).toContain(res.status());
    const text = await res.text();
    const body = JSON.parse(text) as { status: string; commit: string | null; checks: Record<string, unknown> };
    expect(["ok", "degraded"]).toContain(body.status);
    expect(body).toHaveProperty("commit");
    expect(Object.keys(body.checks).sort()).toEqual(["ai", "configuration", "database", "durableJobs"]);
    expect(text).not.toMatch(/PRIVATE KEY|postgres(ql)?:\/\/|ghp_|sk-ant-|SESSION_SECRET|WEBHOOK_SECRET/);
    expect(res.headers()["cache-control"]).toContain("no-store");
  });

  test("@deployed anonymous callers are rejected from private APIs and the dashboard", async ({ request }) => {
    expect((await request.get("/api/jobs")).status()).toBe(401);
    expect((await request.get("/api/jobs/00000000-0000-0000-0000-000000000000")).status()).toBe(401);
    const dash = await request.get("/dashboard", { maxRedirects: 0 });
    expect(dash.status()).toBe(307);
    expect(dash.headers()["location"]).toContain("/api/auth/login");
    expect((await request.post("/api/jobs/00000000-0000-0000-0000-000000000000/retry")).status()).toBe(403); // cross-origin guard first
  });

  test("@deployed webhook endpoint exists, is POST-only, and rejects unsigned or badly signed requests", async ({ request }) => {
    expect((await request.get("/api/github/webhook")).status()).toBe(405);
    const unsigned = await request.post("/api/github/webhook", { data: "{}", headers: { "content-type": "application/json", "x-github-event": "ping", "x-github-delivery": "deployed-probe-1" } });
    expect(unsigned.status()).toBe(401);
    const bad = await request.post("/api/github/webhook", { data: "{}", headers: { "content-type": "application/json", "x-github-event": "ping", "x-github-delivery": "deployed-probe-2", "x-hub-signature-256": "sha256=" + "0".repeat(64) } });
    expect(bad.status()).toBe(401);
  });

  test("@deployed security headers are present", async ({ request }) => {
    const h = (await request.get("/")).headers();
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-powered-by"]).toBeUndefined();
  });

  test("@deployed Inngest endpoint refuses unsigned invocations in production", async ({ request }) => {
    const res = await request.post("/api/inngest", { data: { fake: true }, headers: { "content-type": "application/json" } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });
});
