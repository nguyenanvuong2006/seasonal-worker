/**
 * Worker 360° Profile page ([workerId]/page.tsx) — Electronic Confirmation
 * history rendering, within its own engagement card (2026-09-10 Worker
 * 360° Profile mission, Section 6/8). Real render in jsdom.
 *
 * Sibling file (not nested under [workerId]/) — same Node test-runner
 * bracket-glob quirk documented elsewhere in this feature
 * (confirmation-history-scope.test.ts, issue-single-deadline.test.ts).
 *
 * Migrated from the pre-mission test of the SAME base name that used to
 * test the OLD inline profile view on /admin/worker-profiles (CCCD search
 * rendering the profile directly on the list page). The Worker 360°
 * Profile mission moved profile DETAIL rendering to the canonical
 * opaque-workerId route entirely — the list page is now search-only (see
 * the sibling list-search.test.tsx) — so this test now targets the new
 * route directly and proves the SAME invariant: a returning worker's TWO
 * engagements each keep their OWN confirmation document, newest
 * engagement first, and a confirmed old document still exposes its
 * receipt link.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installDom, loadComponent, type RenderEnv } from "../../../../lib/test-support/render-tsx.ts";

const PROFILE = {
  person: { workerId: "w1", fullName: "Nguyen Van A", fingerprintStatus: null, hasFingerprintCode: false },
  currentState: { lifecycleState: "ACTIVE", deptId: "d1", deptName: "Dept A", groupName: null, section: null, startingDate: "2026-09-01", upcoming: null },
  engagements: [
    {
      session: { id: "sess-2", regDate: "2026-09-01", status: "APPROVED", startingDate: "2026-09-01", endDate: null, endReason: null, endedBy: null, startDateSource: null, dailyApplicationId: "app-2", note: null, itCode: "IT002" },
      organization: { deptId: "d1", deptName: "Dept A", groupName: null, section: null },
      isCurrent: true,
      movements: [],
      electronicDocuments: [
        {
          documentId: "doc-2",
          applicationId: "app-2",
          employmentSessionId: "sess-2",
          engagementStartingDate: "2026-09-01",
          templateVersion: 2,
          templateName: "Mẫu B",
          documentKind: "GENERIC",
          status: "ISSUED",
          effectiveStatus: "ISSUED",
          issuedAt: "2026-09-01T00:00:00Z",
          confirmationDeadlineAt: "2026-09-04T00:00:00Z",
          viewedAt: null,
          confirmedAt: null,
          receiptId: null,
          supersedesDocumentId: null,
        },
      ],
    },
    {
      session: { id: "sess-1", regDate: "2026-01-01", status: "APPROVED", startingDate: "2026-01-01", endDate: "2026-06-01", endReason: "Hết hợp đồng", endedBy: null, startDateSource: null, dailyApplicationId: "app-1", note: null, itCode: "IT001" },
      organization: { deptId: "d1", deptName: "Dept A", groupName: null, section: null },
      isCurrent: false,
      movements: [],
      electronicDocuments: [
        {
          documentId: "doc-1",
          applicationId: "app-1",
          employmentSessionId: "sess-1",
          engagementStartingDate: "2026-01-01",
          templateVersion: 1,
          templateName: "Mẫu A",
          documentKind: "GENERIC",
          status: "CONFIRMED",
          effectiveStatus: "CONFIRMED",
          issuedAt: "2026-01-01T00:00:00Z",
          confirmationDeadlineAt: "2026-01-04T00:00:00Z",
          viewedAt: "2026-01-02T00:00:00Z",
          confirmedAt: "2026-01-02T01:00:00Z",
          receiptId: "receipt-old-1",
          supersedesDocumentId: null,
        },
      ],
    },
  ],
  legacyUnlinkedDocuments: [],
  unlinkedMovements: [],
};

async function renderPage(env: RenderEnv) {
  (globalThis as Record<string, unknown>).fetch = async (input: unknown) => {
    const url = String(input);
    const json = async (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
    if (url.includes("/api/worker-profiles/by-id/")) return json({ profile: PROFILE });
    return json({});
  };

  const uiModule = loadComponent(new URL("../../../../components/ui.tsx", import.meta.url));
  const confirmationDeadlineModule = loadComponent(new URL("../../../../lib/candidate-consent/confirmation-deadline.ts", import.meta.url));
  const nextNavigationStub = { useParams: () => ({ workerId: "w1" }) };

  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  const mod = loadComponent(new URL("./[workerId]/page.tsx", import.meta.url), {
    stubs: {
      "@/components/ui": uiModule,
      "@/lib/candidate-consent/confirmation-deadline": confirmationDeadlineModule,
      "next/navigation": nextNavigationStub,
    },
  });
  const Page = mod.default as () => import("react").ReactElement;

  const container = env.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Page));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  return { container, act, text: () => container.textContent ?? "" };
}

test("worker 360 profile page: TWO engagements each keep their OWN confirmation document, newest engagement first, with a receipt link for a confirmed old entry", async () => {
  const env = installDom();
  try {
    const ui = await renderPage(env);
    const text = ui.text();

    assert.match(text, /Lịch sử làm việc — 2 đợt/);
    assert.match(text, /LẦN 2/, "the newer engagement (sess-2) is numbered LẦN 2");
    assert.match(text, /LẦN 1/, "the older engagement (sess-1) is numbered LẦN 1");
    assert.match(text, /Mẫu B/);
    assert.match(text, /Mẫu A/);
    // Newest engagement (sess-2, LẦN 2) must render before the older one (sess-1, LẦN 1).
    assert.ok(text.indexOf("LẦN 2") < text.indexOf("LẦN 1"));
    assert.match(text, /Biên nhận/, "the confirmed old document must expose its receipt link");

    const receiptLink = [...ui.container.querySelectorAll("a")].find((a) => (a.textContent ?? "").trim() === "Biên nhận") as HTMLAnchorElement;
    assert.ok(receiptLink, "a receipt link element must exist");
    assert.equal(receiptLink.getAttribute("href"), "/xac-thuc-ho-so/receipt-old-1/bien-nhan");
  } finally {
    env.cleanup();
  }
});
