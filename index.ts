import { API_KEY } from "./apikey.ts";
import OpenAI from "openai";
import { chromium, type Locator, type Page } from "playwright";
import fs from "fs";
import path from "path";
import util from "util";

// Все паузы случайные: каждый раз берётся время от MIN до MAX

// после кликов по вариантам
const DELAY_AFTER_ANSWER_MS = { min: 3_000, max: 7_000 };
// это пауза после нажатия «Следующая страница»,
// то есть время, которое скрипт ждёт после перехода на новый вопрос,
// прежде чем начать его обрабатывать.
const DELAY_AFTER_NEXT_MS = { min: 3_000, max: 7_000 };
// пауза между вопросами, когда их несколько на одной странице
const DELAY_BETWEEN_QUESTIONS_MS = { min: 3_000, max: 7_000 };

// Паузы на вопрос (один вопрос на странице): 6-14 секунд

// 3-7с после кликов по вариантам
// 3-7с после нажатия «Следующая страница»

// Переменное время:

// запрос к модели: обычно 1-5 секунд, у deepseek-v4-pro может быть дольше, если модель «думает» (иногда 10+ секунд);
// загрузка страницы после «Далее» (waitForLoadState): около 0,5-2 секунд, зависит от сервера вуза;
// чтение DOM, запись HTML-файла, сами клики: десятки миллисекунд.

const QUESTIONS_AMOUNT = 81;
const URL =
  "https://razoom.mgutm.ru/mod/quiz/attempt.php?attempt=3704638&cmid=423269";

// Имя файла лога (кладётся в папку logs)
const LOG_FILE_NAME = "философия итог.txt";
const LOG_DIR = "logs";

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
const LOG_PATH = path.join(LOG_DIR, LOG_FILE_NAME);

// в файл попадут только строки, начинающиеся с этих префиксов
const FILE_PREFIXES = ["=====", "QUESTION:", "[MODEL]", "[ANSWER]", "OPTIONS"];

for (const method of ["log", "warn", "error"] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    original(...args);
    const line = util.format(...args);
    if (FILE_PREFIXES.some((p) => line.trimStart().startsWith(p))) {
      fs.appendFileSync(LOG_PATH, line + "\n", "utf-8");
    }
  };
}

async function randomDelay(page: Page, delay: { min: number; max: number }) {
  const ms = delay.min + Math.random() * (delay.max - delay.min);
  console.log(`[DELAY] ${(ms / 1000).toFixed(1)} с`);
  await page.waitForTimeout(ms);
}

type Mode = "single" | "multiple" | "unsupported";
type Option = { letter: string; text: string };

const openai = new OpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: API_KEY,
  timeout: 20_000,
  maxRetries: 0,
});

// ---------- Определение типа вопроса ----------
// que — блок одного вопроса (div.que), все поиски идут внутри него
async function detectMode(que: Locator): Promise<Mode> {
  const radios = await que.locator('.answer input[type="radio"]').count();
  const checkboxes = await que
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
Допустимые буквы: ${letters.join(", ")}.
`;

  const rule = multiple
    ? "В этом вопросе несколько правильных ответов. Верни все подходящие буквы."
    : "В этом вопросе ровно один правильный ответ. Верни одну букву.";

  const user = `Вопрос:\n${question}\n\nВарианты:\n${optionsText}\n\n${rule}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const completion = await openai.chat.completions.create({
        model: "deepseek-flash",
        temperature: 0,
        response_format: { type: "json_object" },
        // отключаем рассуждение (параметр из раздела Thinking Mode)
        // @ts-expect-error нестандартное поле DeepSeek
        thinking: { type: "disabled" },
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

  let questionNumber = 0;

  for (let pageIndex = 0; questionNumber < QUESTIONS_AMOUNT; pageIndex++) {
    const filePath = path.join(dir, `page_${pageIndex}.html`);
    fs.writeFileSync(filePath, await page.content(), "utf-8");
    console.log("Saved:", filePath);

    // На одной странице может быть несколько вопросов — каждый в своём div.que
    const blocks = await page.locator("div.que").all();
    console.log(`[PAGE] Страница ${pageIndex + 1}, вопросов: ${blocks.length}`);

    for (const que of blocks) {
      questionNumber++;
      console.log(
        `\n========== Вопрос ${questionNumber} из ${QUESTIONS_AMOUNT} ==========`,
      );

      const question = await que.locator(".qtext").innerText();
      console.log("QUESTION:", question);

      // Определяем тип вопроса
      const mode = await detectMode(que);
      if (mode === "unsupported") {
        console.log("Пропускаю: ответь на этот вопрос вручную.");
        continue;
      }
      const multiple = mode === "multiple";

      // Читаем варианты только внутри этого вопроса
      // Если в тесте нумерация вариантов выключена (.answernumber пустой),
      // буквы проставляем сами по порядку: a, b, c...
      const options: Option[] = await que.evaluate((el) => {
        const rows = [...el.querySelectorAll(".answer > div")];

        return rows.map((row, idx) => {
          const number = row.querySelector(
            ".answernumber",
          ) as HTMLElement | null;
          const text = row.querySelector(
            ".flex-fill.ml-1",
          ) as HTMLElement | null;
          const letter = number?.innerText.replace(".", "").trim() ?? "";
          return {
            letter: letter || String.fromCharCode(97 + idx),
            text: text?.innerText.trim() || "",
          };
        });
      });

      console.log("OPTIONS:", options);

      if (options.length === 0) {
        console.log("Варианты не найдены, проверь селекторы. Пропускаю.");
        continue;
      }

      // Спрашиваем модель
      const letters = await askModel(question, options, multiple);
      console.log(`[ANSWER] Режим: ${mode}, выбрано:`, letters);

      // Кликаем по выбранным вариантам этого вопроса
      const inputType = multiple
        ? 'input[type="checkbox"]'
        : 'input[type="radio"]';
      // Кликаем по порядковому номеру варианта, а не по тексту буквы —
      // так работает и когда буквы на странице не выводятся
      for (const letter of letters) {
        const idx = options.findIndex((o) => o.letter.toLowerCase() === letter);
        await que.locator(".answer > div").nth(idx).locator(inputType).click();
        console.log(`[CLICK] ${letter}`);
      }

      // Пауза между вопросами, только если их несколько на странице
      // (после последнего не нужна — дальше идёт DELAY_AFTER_ANSWER_MS)
      if (que !== blocks[blocks.length - 1]) {
        await randomDelay(page, DELAY_BETWEEN_QUESTIONS_MS);
      }
    }

    await randomDelay(page, DELAY_AFTER_ANSWER_MS);

    // Кнопка "Далее"; на последней странице её нет
    const next = page.locator("input.mod_quiz-next-nav");
    if ((await next.count()) === 0) {
      console.log("Кнопки 'Далее' нет — вероятно, это последняя страница.");
      break;
    }
    await next.click();

    await page.waitForLoadState("load");
    await randomDelay(page, DELAY_AFTER_NEXT_MS);
  }

  console.log("\nГотово.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
