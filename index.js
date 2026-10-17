import { API_KEY } from "./apikey.js";
import OpenAI from "openai";
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const openai = new OpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: API_KEY,
});

async function run() {
  let i = 0;
  throw Error;
  const context = await chromium.launchPersistentContext("./user-data", {
    headless: false,
  });

  const page = await context.newPage();

  await page.goto(
    "https://razoom.mgutm.ru/mod/quiz/attempt.php?attempt=3499319&cmid=466405",
  );

  // ПАУЗА ДЛЯ ЛОГИНА (10 секунд)
  console.log("Войди в аккаунт...");
  await page.waitForTimeout(10000);

  const dir = "htmls";
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }

  while (i < 5) {
    const html = await page.content();

    const filePath = path.join(dir, `page_${i}.html`);

    fs.writeFileSync(filePath, html, "utf-8");

    console.log("Saved:", filePath);

    const question = await page.locator(".qtext").innerText();
    console.log("QUESTION:", question);

    // const answers = await page.locator('.flex-fill.ml-1').allInnerTexts();
    // console.log("ANSWERS:", answers);
    const options = await page.evaluate(() => {
      const numbers = [...document.querySelectorAll(".answernumber")];
      const texts = [...document.querySelectorAll(".flex-fill.ml-1")];

      return numbers.map((n, i) => ({
        letter: n.innerText.replace(".", "").trim(),
        text: texts[i]?.innerText.trim() || "",
      }));
    });

    console.log(options, "options");

    const fullOption = options.map((o) => `${o.letter} ${o.text}`).join("\n");
    console.log(fullOption);

    await page
      .locator(".answer > div", {
        has: page.locator(".answernumber", { hasText: `${res}.` }),
      })
      .locator('input[type="radio"]')
      .click();

    await page.waitForTimeout(2000);

    await page.locator("input.mod_quiz-next-nav").click();

    i++;

    await new Promise((res) => setTimeout(res, 15000));
  }
}

run();
