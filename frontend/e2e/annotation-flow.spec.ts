import { expect, test, type Page } from "@playwright/test";

async function loginAsNewAnnotator(page: Page, request: import("@playwright/test").APIRequestContext) {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "e2e-pass-1234";

  const registerResponse = await request.post("http://localhost:8000/auth/register", {
    data: { email, password, role: "annotator" },
  });
  expect(registerResponse.ok()).toBe(true);

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/media$/);

  return { email, password };
}

test("annotator can log in, upload a video, and extract a sequence", async ({ page, request }) => {
  const videoTitle = `E2E procedure ${Date.now()}`;

  await loginAsNewAnnotator(page, request);

  await expect(page).toHaveURL(/\/media$/);

  await page.getByLabel("Title").fill(videoTitle);
  await page.getByLabel("Choose video").setInputFiles("e2e/fixtures/tiny.mp4");
  await page.getByRole("button", { name: "Upload video" }).click();

  const extractForm = page.locator("form", { has: page.getByLabel("Start (s)") });
  await expect(extractForm).toBeVisible({ timeout: 10_000 });
  await extractForm.getByLabel("Procedure").selectOption({ index: 1 });
  await extractForm.getByRole("button", { name: "Create sequence" }).click();

  await expect(page).toHaveURL(/\/sequences\/\d+/);
  await expect(page.getByRole("img").first()).toBeVisible({ timeout: 10_000 });
});

test("uploading a video and extracting a sequence with a crop box lands on the sequence grid", async ({
  page,
  request,
}) => {
  await loginAsNewAnnotator(page, request);
  await page.goto("/media");

  await page.getByLabel("Title").fill("E2E crop video");
  await page.getByLabel("Choose video").setInputFiles("e2e/fixtures/tiny.mp4");
  await page.getByRole("button", { name: "Upload video" }).click();

  const extractForm = page.locator("form", { has: page.getByLabel("Start (s)") });
  await expect(extractForm).toBeVisible({ timeout: 10_000 });
  await extractForm.getByLabel("Procedure").selectOption({ index: 1 });
  await extractForm.getByRole("button", { name: /crop box/i }).click();
  await extractForm.getByLabel("left %").fill("10");
  await extractForm.getByLabel("right %").fill("10");
  await extractForm.getByRole("button", { name: "Create sequence" }).click();

  await expect(page).toHaveURL(/\/sequences\/\d+/);
  await expect(page.getByRole("img").first()).toBeVisible();
});

test("uploading a batch of photos lands on the sequence grid with all frames", async ({ page, request }) => {
  await loginAsNewAnnotator(page, request);
  await page.goto("/media");

  const photosForm = page.locator("form", { has: page.getByLabel("Choose photos") });
  await photosForm.getByLabel("Choose photos").setInputFiles([
    "e2e/fixtures/tiny_frame.png",
    "e2e/fixtures/tiny_frame.png",
  ]);
  await photosForm.getByLabel("Procedure").selectOption({ index: 1 });
  await photosForm.getByRole("button", { name: "Create sequence" }).click();

  await expect(page).toHaveURL(/\/sequences\/\d+/);
  await expect(page.getByRole("img")).toHaveCount(2);
});
