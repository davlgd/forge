import type { Page } from "playwright";

export async function chooseOwner(page: Page, login: string) {
  const trigger = page.locator("#owner-toggle");
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await trigger.click();
  await page.locator(`#owner-options button[data-owner="${login}"]`).click();
}

export async function chooseTheme(page: Page, theme: string) {
  const trigger = page.locator("#profile-toggle");
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await trigger.click();
  await page.locator(`input[name="theme"][value="${theme}"]`).check();
  await page.keyboard.press("Escape");
}

export async function selectedTheme(page: Page) {
  return page.locator('input[name="theme"]:checked').inputValue();
}
