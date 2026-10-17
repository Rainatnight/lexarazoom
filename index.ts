import { API_KEY } from "./apikey.js";
import OpenAI from "openai";
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const QUESTIONS_AMOUNT = 5;

const openai = new OpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: API_KEY,
});

async function askModel(q: string, a: string) {
  const completion = await openai.chat.completions.create({
    model: "deepseek-v4-pro",
    messages: [
      {
        role: "user",
        content: `Вот вопрос:\n${q}. Вот варианты ответа${a}. content: 
Верни только одну букву варианта ответа.
Допустимые значения: a, b, c, d.
Не добавляй пояснений.
`,
      },
    ],
  });

  return completion.choices[0].message.content;
}

async function run() {
  let i = 0;

  const context = await chromium.launchPersistentContext("./user-data", {
    headless: false,
    ignoreHTTPSErrors: true,
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

  // Кол-во вопросов
  while (i < QUESTIONS_AMOUNT) {
    const html = await page.content();

    const filePath = path.join(dir, `page_${i}.html`);

    fs.writeFileSync(filePath, html, "utf-8");

    console.log("Saved:", filePath);

    const question = await page.locator(".qtext").innerText();
    console.log("QUESTION:", question);

    const options = await page.evaluate(() => {
      const numbers = [...document.querySelectorAll(".answernumber")];
      const texts = [...document.querySelectorAll(".flex-fill.ml-1")] as any;

      return numbers.map((n: any, i) => ({
        letter: n.innerText.replace(".", "").trim(),
        text: texts[i]?.innerText.trim() || "",
      }));
    });

    console.log(options, "options");

    const fullOption = options.map((o) => `${o.letter} ${o.text}`).join("\n");
    console.log(fullOption);

    const res = await askModel(question, fullOption);
    console.log(res);

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

// stud051649
// nU3K#rm4
