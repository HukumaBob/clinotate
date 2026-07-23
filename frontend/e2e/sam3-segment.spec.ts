import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("annotator can segment a frame with SAM-3 and see the resulting mask annotation", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);

  const email = `e2e-sam3-${Date.now()}@example.com`;
  const password = "e2e-pass-1234";
  const labelName = `E2E SAM3 Landmark ${Date.now()}`;

  const registerResponse = await request.post("http://localhost:8000/auth/register", {
    data: { email, password, role: "annotator" },
  });
  expect(registerResponse.ok()).toBe(true);

  const loginResponse = await request.post("http://localhost:8000/auth/login", {
    data: { email, password },
  });
  const { access_token: token } = await loginResponse.json();
  const authHeaders = { Authorization: `Bearer ${token}` };

  // Phase 1's pattern (see annotation-flow.spec.ts): create a real Label via the
  // API first so there is something to select in the SegmentButton's LabelPicker.
  const labelCreateResponse = await request.post("http://localhost:8000/taxonomy/labels", {
    headers: authHeaders,
    data: { name: labelName, label_type: "geometric" },
  });
  const label = await labelCreateResponse.json();

  // Deliberately NOT tiny.mp4 (Phase 1's fixture, shared with annotation-flow.spec.ts):
  // that clip is a solid black 64x48 frame with zero visual content, which is fine for
  // Phase 1's pixel-content-agnostic assertions but means real SAM-3 inference legitimately
  // finds no segmentable mask anywhere in it (confirmed: a real run against tiny.mp4 produced
  // Job.status=FAILED with error "SAM-3 returned no masks above the confidence threshold for
  // the given prompts" -- a real, expected model response given blank input, not a worker bug).
  // sam3-segment.mp4 is a 256x256 clip with a light ellipse centered in an otherwise dark
  // frame (same style as ml-worker/tests/fixtures/sample_frame.png, already proven to produce
  // a real mask from a center point prompt in test_sam3_adapter.py), so a center click has
  // real content for SAM-3 to segment.
  const uploadResponse = await request.post("http://localhost:8000/media/videos", {
    headers: authHeaders,
    multipart: {
      title: `SAM3 e2e ${Date.now()}`,
      file: {
        name: "sam3-segment.mp4",
        mimeType: "video/mp4",
        buffer: readFileSync(path.join(__dirname, "..", "tests", "fixtures", "sam3-segment.mp4")),
      },
    },
  });
  const video = await uploadResponse.json();

  const sequenceResponse = await request.post(
    `http://localhost:8000/media/videos/${video.id}/sequences`,
    {
      headers: authHeaders,
      data: { start_time: 0, duration: 2 },
    },
  );
  const sequence = await sequenceResponse.json();

  const framesResponse = await request.get(
    `http://localhost:8000/media/sequences/${sequence.id}/frames`,
    { headers: authHeaders },
  );
  const frames = await framesResponse.json();
  const firstFrame = frames[0];

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/videos$/);

  await page.goto(`/frames/${firstFrame.id}`);

  // SegmentButton.tsx: clicking "Segment with SAM-3" renders a LabelPicker
  // (label must be selected) before the click-target div appears at all.
  await page.getByRole("button", { name: "Segment with SAM-3" }).click();

  // The page renders two LabelPickers (SegmentButton's inline picker, and the
  // sidebar's own LabelPicker for creating classification annotations). Scope
  // to the main content area, which only contains SegmentButton's picker.
  const mainContent = page.locator("div.grid > div").first();
  await expect(mainContent.getByRole("button", { name: labelName })).toBeVisible();
  await mainContent.getByRole("button", { name: labelName }).click();

  // Click near the center of the click-target div: SegmentButton normalizes the click
  // position against the div's own bounding box to a [0,1] fraction regardless of the
  // target's actual pixel size, so a center click lands at ~(0.5, 0.5) on the uploaded
  // frame -- exactly where sam3-segment.mp4's segmentable ellipse is centered.
  const clickTarget = page.getByTestId("segment-click-target");
  const box = await clickTarget.boundingBox();
  if (!box) throw new Error("segment-click-target has no bounding box");
  await clickTarget.click({ position: { x: box.width / 2, y: box.height / 2 } });

  await expect(page.getByText(/SAM-3 job #\d+: succeeded/)).toBeVisible({ timeout: 60_000 });

  const annotationsResponse = await request.get(
    `http://localhost:8000/annotation/frames/${firstFrame.id}/annotations`,
    { headers: authHeaders },
  );
  const annotations = await annotationsResponse.json();
  const maskAnnotation = annotations.find(
    (a: { annotation_type: string; label_id: number }) =>
      a.annotation_type === "mask" && a.label_id === label.id,
  );
  expect(maskAnnotation).toBeTruthy();
  expect(maskAnnotation.status).toBe("draft");
});
