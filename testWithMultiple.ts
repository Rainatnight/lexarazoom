type Answer = { answers: string[] };

async function askModel(
  question: string,
  options: { letter: string; text: string }[],
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
  const parsed = JSON.parse(raw) as Answer;

  const result = parsed.answers
    .map((a) => a.trim().toLowerCase().replace(".", ""))
    .filter((a) => letters.includes(a));

  if (result.length === 0) throw new Error(`Некорректный ответ модели: ${raw}`);
  return multiple ? result : result.slice(0, 1);
}

const multiple =
  (await page.locator('.answer input[type="checkbox"]').count()) > 0;
