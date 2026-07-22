import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("annotator can log in, upload a video, and classify a frame", async ({ page, request }) => {
  const email = `e2e-${Date.now()}@example.com`;
  const password = "e2e-pass-1234";
  const videoTitle = `E2E procedure ${Date.now()}`;

  const registerResponse = await request.post("http://localhost:8000/auth/register", {
    data: { email, password, role: "annotator" },
  });
  expect(registerResponse.ok()).toBe(true);

  const labelResponse = await request.post("http://localhost:8000/auth/login", {
    data: { email, password },
  });
  const { access_token: token } = await labelResponse.json();

  await request.post("http://localhost:8000/taxonomy/labels", {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: "E2E Landmark", label_type: "geometric" },
  });

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/videos$/);

  await page.getByPlaceholder("Title").fill(videoTitle);
  await page.setInputFiles('input[type="file"]', path.join(__dirname, "..", "tests", "fixtures", "tiny.mp4"));
  await page.getByRole("button", { name: "Upload" }).click();

  await expect(page.getByText(videoTitle)).toBeVisible({ timeout: 10_000 });
});
