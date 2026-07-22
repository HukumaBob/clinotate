import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("annotator can log in, upload a video, and classify a frame", async ({ page, request }) => {
  const email = `e2e-${Date.now()}@example.com`;
  const password = "e2e-pass-1234";
  const videoTitle = `E2E procedure ${Date.now()}`;
  const labelName = `E2E Landmark ${Date.now()}`;

  const registerResponse = await request.post("http://localhost:8000/auth/register", {
    data: { email, password, role: "annotator" },
  });
  expect(registerResponse.ok()).toBe(true);

  const loginResponse = await request.post("http://localhost:8000/auth/login", {
    data: { email, password },
  });
  const { access_token: token } = await loginResponse.json();
  const authHeaders = { Authorization: `Bearer ${token}` };

  const labelCreateResponse = await request.post("http://localhost:8000/taxonomy/labels", {
    headers: authHeaders,
    data: { name: labelName, label_type: "geometric" },
  });
  const label = await labelCreateResponse.json();

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/videos$/);

  await page.getByPlaceholder("Title").fill(videoTitle);
  await page.setInputFiles('input[type="file"]', path.join(__dirname, "..", "tests", "fixtures", "tiny.mp4"));
  await page.getByRole("button", { name: "Upload" }).click();

  await expect(page.getByText(videoTitle)).toBeVisible({ timeout: 10_000 });

  const videosResponse = await request.get("http://localhost:8000/media/videos", {
    headers: authHeaders,
  });
  const videos = await videosResponse.json();
  const uploadedVideo = videos.find((video: { title: string }) => video.title === videoTitle);
  expect(uploadedVideo).toBeTruthy();

  const sequenceResponse = await request.post(
    `http://localhost:8000/media/videos/${uploadedVideo.id}/sequences`,
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
  expect(frames.length).toBeGreaterThan(0);
  const firstFrame = frames[0];

  await page.goto(`/frames/${firstFrame.id}`);

  await expect(page.getByText(labelName)).toBeVisible();
  await page.getByText(labelName).click();

  await expect(page.getByText(`Label #${label.id} — draft`)).toBeVisible({ timeout: 10_000 });
});
