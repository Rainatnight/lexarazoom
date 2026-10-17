import { API_KEY } from "./apikey.ts";
import OpenAI from "openai";
import { chromium, type Page } from "playwright";
import fs from "fs";
import path from "path";

const QUESTIONS_AMOUNT = 5;
const URL =
  "https://razoom.mgutm.ru/mod/quiz/attempt.php?attempt=3499319&cmid=466405";

// после кликов по вариантам
const DELAY_AFTER_ANSWER_MS = 2_000;
// это пауза после нажатия «Следующая страница»,
// то есть время, которое скрипт ждёт после перехода на новый вопрос,
// прежде чем начать его обрабатывать.
const DELAY_AFTER_NEXT_MS = 2_000;

type Mode = "single" | "multiple" | "unsupported";
type Option = { letter: string; text: string };

const openai = new OpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: API_KEY,
});

// ---------- Определение типа вопроса ----------
async function detectMode(page: Page): Promise<Mode> {
  const radios = await page.locator('.answer input[type="radio"]').count();
  const checkboxes = await page
    .locator('.answer input[type="checkbox"]')
    .count();

  console.log(`[MODE] radio: ${radios}, checkbox: ${checkboxes}`);

  if (checkboxes > 0) {
    console.log("[MODE] Найдены чекбоксы -> МНОЖЕСТВЕННЫЙ выбор");
    return "multiple";
  }
  if (radios > 0) {
    console.log("[MODE] Найдены радиокнопки -> ОДИНОЧНЫЙ выбор");
    return "single";
  }
  console.log("[MODE] Ни radio, ни checkbox -> тип не поддерживается");
  return "unsupported";
}

// ---------- Запрос к модели ----------
async function askModel(
  question: string,
  options: Option[],
  multiple: boolean,
): Promise<string[]> {
  const letters = options.map((o) => o.letter.toLowerCase());
  const optionsText = options.map((o) => `${o.letter}) ${o.text}`).join("\n");

  const system = `Ты отвечаешь на вопросы тестов по учебным дисциплинам.
Выбирай ответ, опираясь на общепринятые знания и стандартную терминологию.
Верни ТОЛЬКО JSON вида {"answers": ["a"]}, без пояснений и без markdown.
Допустимые буквы: ${letters.join(", ")}.`;

  const rule = multiple
    ? "В этом вопросе несколько правильных ответов. Верни все подходящие буквы."
    : "В этом вопросе ровно один правильный ответ. Верни одну букву.";

  const user = `Вопрос:\n${question}\n\nВарианты:\n${optionsText}\n\n${rule}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
        model: "deepseek-v4-pro",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });

      const raw = completion.choices[0].message.content ?? "{}";
      console.log(`[MODEL] Сырой ответ (попытка ${attempt}):`, raw);

      const parsed = JSON.parse(raw) as { answers?: string[] };
      const result = (parsed.answers ?? [])
        .map((a) => String(a).trim().toLowerCase().replace(".", ""))
        .filter((a) => letters.includes(a));

      if (result.length === 0) throw new Error("Нет допустимых букв в ответе");

      return multiple ? [...new Set(result)] : result.slice(0, 1);
    } catch (e) {
      console.warn(`[MODEL] Ошибка на попытке ${attempt}:`, e);
      if (attempt === 3) throw e;
    }
  }
  return [];
}

// ---------- Основной сценарий ----------
async function run() {
  const context = await chromium.launchPersistentContext("./user-data", {
    headless: false,
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();
  await page.goto(URL);

  console.log("Войди в аккаунт...");
  await page.waitForTimeout(10000);

  const dir = "htmls";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);

  for (let i = 0; i < QUESTIONS_AMOUNT; i++) {
    console.log(
      `\n========== Вопрос ${i + 1} из ${QUESTIONS_AMOUNT} ==========`,
    );

    const filePath = path.join(dir, `page_${i}.html`);
    fs.writeFileSync(filePath, await page.content(), "utf-8");
    console.log("Saved:", filePath);

    const question = await page.locator(".qtext").innerText();
    console.log("QUESTION:", question);

    // Определяем тип вопроса
    const mode = await detectMode(page);
    if (mode === "unsupported") {
      console.log("Останавливаюсь: ответь на этот вопрос вручную.");
      break;
    }
    const multiple = mode === "multiple";

    // Читаем варианты
    const options: Option[] = await page.evaluate(() => {
      const numbers = [...document.querySelectorAll(".answernumber")];
      const texts = [...document.querySelectorAll(".flex-fill.ml-1")];

      return numbers.map((n, idx) => ({
        letter: (n as HTMLElement).innerText.replace(".", "").trim(),
        text: (texts[idx] as HTMLElement | undefined)?.innerText.trim() || "",
      }));
    });

    console.log("OPTIONS:", options);

    if (options.length === 0) {
      console.log("Варианты не найдены, проверь селекторы. Останавливаюсь.");
      break;
    }

    // Спрашиваем модель
    const letters = await askModel(question, options, multiple);
    console.log(`[ANSWER] Режим: ${mode}, выбрано:`, letters);

    // Кликаем по выбранным вариантам
    const inputType = multiple
      ? 'input[type="checkbox"]'
      : 'input[type="radio"]';
    for (const letter of letters) {
      await page
        .locator(".answer > div", {
          has: page.locator(".answernumber", {
            hasText: new RegExp(`^\\s*${letter}\\.?\\s*$`, "i"),
          }),
        })
        .locator(inputType)
        .click();
      console.log(`[CLICK] ${letter}`);
    }

    await page.waitForTimeout(DELAY_AFTER_ANSWER_MS);

    // Кнопка "Далее"; на последней странице её нет
    const next = page.locator("input.mod_quiz-next-nav");
    if ((await next.count()) === 0) {
      console.log("Кнопки 'Далее' нет — вероятно, это последний вопрос.");
      break;
    }
    await next.click();

    await page.waitForTimeout(DELAY_AFTER_NEXT_MS);
  }

  console.log("\nГотово.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
