# Как пользоваться панелью

Открыл дашборд — нажал кнопку — получил ответ. Всё остальное (команды, конфиги) нужно только агентам и автоматизации.

```
node bin/vibe.js serve
```

Откроется `http://127.0.0.1:5173`. Если порт занят: `node bin/vibe.js serve --port 5174`.

---

## Шесть кнопок

Вверху страницы блок **«Что сделать?»**. Каждая кнопка — готовый сценарий. Результат появляется сразу под кнопками.

| Кнопка | Что делает | Что вы получите |
|---|---|---|
| **Что требует решения** | Оставляет в сетке только проекты с проблемами, сортирует по приоритету | Список, с которого начинать утро: дубли, застой, нет git или тестов |
| **Найти похожие файлы** | Фильтрует дубли до «похожих» | Файлы, которые разошлись между проектами, с процентом расхождения |
| **Что можно удалить** | Считает неканонические точные копии | Сколько файлов и мегабайт можно освободить, по проектам |
| **Обновить данные** | Пересчитывает состояние с диска | Свежие цифры; прогресс видно в живой ленте справа |
| **Собрать отчёт** | Генерирует Markdown + HTML по всем проектам | Две кнопки-ссылки: открыть HTML или Markdown |
| **Контекст для новой сессии** | Собирает сводку текущего состояния | Готовый текст — скопировать и вставить первым сообщением новому агенту |

---

## Разбор по сценариям

### Что требует решения

Самая полезная кнопка. Панель отбрасывает здоровые проекты и оставляет те, у которых есть флаги: дубли, застой, нет git, нет тестов, незакоммиченные изменения.

Порядок не случайный: сначала проекты с наибольшим числом проблем, внутри — с самым низким скором. **Берите первый и закрывайте флаги по одному.**

Клик по карточке раскрывает разбивку скора: за что начислено и за что снято (штрафы).

### Найти похожие файлы

Это не точные копии. Это файлы, похожие по minhash-подписи — обычно общий модуль, который разъехался между проектами.

В заголовке каждой группы показан **процент расхождения**. Чем он больше, тем опаснее «просто удалить копию»: где-то мог остаться нужный код. Такие файлы нужно **сверить**, а не удалять.

Точные копии (расхождение 0%) в этом режиме не показываются — для них есть следующая кнопка.

### Что можно удалить

Показывает только **точные** клоны. В каждой группе панель выбирает канон — файл, который храним (у проекта выше скор и свежее активность). Остальные копии и попадают в отчёт.

Таблица даёт три вещи:

- **Сколько освободится** — в байтах и файлах, по каждому проекту.
- **Целиком не уникален** — проект, у которого ни одна копия не стала каноном. Его можно убрать целиком, но сначала убедитесь, что живой канон есть в другом месте.
- **Панель ничего не удаляет сама.** Это список для вашего решения.

### Обновить данные

Полный пересчёт: обход каталогов, git, дубли. Прогресс идёт в живой ленте справа, карточки обновятся сами.

Если правили один проект, полный скан не нужен — обновите его отдельно из консоли: `node bin/vibe.js refresh <имя>` (доли секунды вместо ~11 с).

### Собрать отчёт

Один файл со всем: стадии, что требует решения, дубли, кандидаты на удаление. Удобно приложить к чему-то или вернуться к срезу позже. Файлы складываются в `reports/`.

### Контекст для новой сессии

Решает главную боль: обрыв связи, новая сессия начинает с нуля.

Кнопка собирает markdown-сводку: сколько проектов и в каком состоянии, **топ проблемных с путями**, кто держит аренды, крупнейшие группы клонов, кандидаты на удаление и план из трёх шагов. У проблемных проектов в сводке теперь есть строка **«↳ последний работал X (когда): что сделал»** — это из handoff-пакетов (см. ниже).

Нажали «Скопировать» → вставили первым сообщением. Новый агент сразу в контексте.

То же самое без браузера: `node bin/vibe.js brief` из консоли (или MCP-инструмент
`vibe_brief`) — агент получает ту же сводку, не поднимая дашборд.

### Передача контекста между агентами (handoff)

Обрыв связи не должен сбрасывать работу в ноль. Когда агент закончил (или передаёт
проект другому), он пишет пакет:

```bash
node bin/vibe.js handoff <проект> --owner <ты> --note "починил дубли в X, остался Y"
```

Запись ложится в `.vibe/handoffs.jsonl` (кто, что, какие файлы). Следующий агент читает
её одной командой (или через MCP `vibe_handoff_read`) и сразу знает, с чего начинать:

```bash
node bin/vibe.js handoff read <проект>
# → Последняя сессия · <owner> (<когда>): что сделал
```

Одной последней записи мало, когда агенты параллельно работают в соседних проектах.
Поэтому есть лента:

```bash
node bin/vibe.js handoff read <проект> --limit 5   # N последних пакетов проекта
node bin/vibe.js handoff read --all --limit 10     # кросс-проектная лента по всему портфелю
```

`--all` показывает, кто и что делал во всех проектах — раньше для этого приходилось
читать `.vibe/handoffs.jsonl` вручную.

Через MCP то же самое: `vibe_handoff_write` (требует `owner`) и `vibe_handoff_read`.
Папка запуска агента не важна — общие `.vibe/`-файлы и глобальный MCP `vibe` видны
всем агентам. Это и есть координация через панель: без ручного копирования сводок
между чатами.

---

## Что ещё есть на странице

| Элемент | Зачем |
|---|---|
| Карточки сверху | Общая сводка: проектов, средний скор, групп дублей, можно освободить |
| Поиск и сортировка | Найти проект по имени или пути; сортировки — по приоритету, скору, застою, имени |
| Чипы стадий S0–S5 | Отфильтровать по готовности: идея → прод |
| Живая лента | Что происходит прямо сейчас: скан, аренды, изменения файлов. Зелёная точка — соединение живое. Отдельно показывается **запись под чужой арендой** — когда кто-то правит файл, который держит другой агент |
| Аренды | Кто и какой файл держит, сколько осталось до истечения |
| Подозрительные группы проектов | Проекты-тёзки: `salebot`, `salebot-backup`, `salebot-next16` |
| Дубли файлов | Группы клонов с пометкой «канон» — что хранить, а что копия |

---

## Настройки

Кнопка **⚙ Настройки** в шапке. Меняется прямо в браузере, без перезапуска.

| Поле | Смысл |
|---|---|
| Корни сканирования | Какие каталоги обходить. Один путь на строку |
| Игнорируемые каталоги | Маски, по одной на строку. `node_modules`, `.git`, `dist` и прочие служебные добавляются всегда |
| TTL аренд, минут | Сколько живёт аренда файла. По умолчанию 30 |
| Порог похожести | Чувствительность поиска похожих файлов. `0.95` — только почти идентичные, `0.75` — находок больше, но и ложных тоже |
| Глубина обхода | Насколько глубоко спускаться в каталоги |
| Мин. строк в клоне | Короче — не считаем дублем |

После смены корней или порогов нажмите **Обновить данные** — иначе цифры останутся старыми.

То же самое можно править руками в `.vibe/config.json`. Реальные ключи:

```jsonc
{
  "roots": ["<YOUR_PROJECTS_DIR>"],
  "ignore": ["__to_delete__*", ".next-failed*"],
  "maxDepth": 8,
  "maxFilesPerProject": 20000,
  "staleDays": [30, 60, 180],
  "dup": {
    "minSize": 128,
    "maxSize": 262144,
    "minLines": 5,
    "near": true,
    "nearThreshold": 0.85
  },
  "leases": { "ttlMinutes": 30 },
  "rating": { "weights": { "monetization": 0.6, "readiness": 0.4 } },
  "monetization": { "vechnomolod": { "value": 100 } }
}
```

### Веса скора готовности

Компоненты readiness-скора настраиваются — если «у кого больше кода, тот и готов»
не совпадает с вашим ощущением, раскладку можно перекроить:

```jsonc
{
  "score": {
    "weights": {
      "idea": 10,      // README + ТЗ/план
      "scaffold": 20,  // манифест, lock-файл, есть код
      "core": 22,      // объём ядра (файлы и строки)
      "tests": 20,     // тесты
      "config": 10,    // .env.example, конфиг, .gitignore
      "deploy": 8,     // Docker, CI, скрипт запуска
      "docs": 10       // README + контекст для агента
    }
  }
}
```

Сумма не обязана быть ровно 100, но желательно: скор — это сумма весов.
Отсутствующие ключи берутся из значения по умолчанию, неизвестные — отклоняются
с ошибкой. После правки нажмите **Обновить данные**: скор пересчитывается при скане.

Раскладка по умолчанию откалибрована на реальном портфеле (см. комментарии
в `src/score.js` и `tools/score-calib.mjs`): вес «ядра» снижен с 25 до 22
(компонента насыщалась у 46% проектов — скор превращался в измерение объёма
кода), вес тестов поднят с 15 до 20, деплоя урезан с 10 до 8 (у 80% проектов
там ноль — вес не работал).

---

## Консоль — агентам и автоматизации

Из интерфейса это не делается, поэтому здесь.

```bash
# Аренды: чтобы два агента не перетирали один файл
node bin/vibe.js lease <проект> <файл|.> --owner <имя> [--ttl 30] [--reason "зачем"]
node bin/vibe.js release <проект> <файл> --owner <имя>
node bin/vibe.js leases                  активные аренды
node bin/vibe.js conflicts               журнал конфликтов (в т.ч. запись под чужой арендой)
node bin/vibe.js agents-md               правила аренд в AGENTS.md (+ CLAUDE.md-прокладка)
node bin/vibe.js agents-md --project X   то же, но в каталог проекта X
node bin/vibe.js agents-md --no-shim     только AGENTS.md, без CLAUDE.md
node bin/vibe.js agents-md --active [--dry-run] [--max-idle N]   раскатить правила сразу во все подходящие проекты

# Передача контекста между агентами (Приоритет 2)
node bin/vibe.js handoff <проект> --owner <ты> [--note "что сделал"] [--summary S] [--files f1,f2]
node bin/vibe.js handoff read <проект> [--limit N]   кто работал передо мной (N последних пакетов)
node bin/vibe.js handoff read --all [--limit N]      лента по ВСЕМ проектам: активность соседей

# Контекст для старта сессии из консоли (то же, что кнопка и MCP vibe_brief)
node bin/vibe.js brief

# Точечное обновление вместо полного скана
node bin/vibe.js refresh <имя>           ~0.2 с против ~11 с
node bin/vibe.js watch                   следить и пересчитывать автоматически

# Первичная настройка
node bin/vibe.js init --root "<YOUR_PROJECTS_DIR>"
node bin/vibe.js scan
```

### Запись под чужой арендой (Приоритет 3)

Файловая система не сообщает, кто изменил файл, поэтому панель использует
два источника — и честно помечает, насколько событие достоверно:

| Откуда | Что видно | Как выглядит в ленте |
|---|---|---|
| PreToolUse-хук агента | писатель и держатель | «Запись под чужой арендой: X пишет в файл, держит Y» |
| `vibe watch` | только держатель | «Файл под арендой изменился (держит Y, автор неизвестен)» |

Хук — точный источник: он знает имя пишущего агента (`VIBE_AGENT`). Его факт
попадает и в `vibe conflicts`. Watch — резерв для агентов без хука: держатель
мог править файл и сам, поэтому такие события помечены как неподтверждённые.

Отключается флагом `leases.detectWrites: false` в `.vibe/config.json`;
частота записи — `leases.violationCooldownMs` (по умолчанию 60 с на файл).

---

## MCP — панель как инструмент агента

Панель зарегистрирована как MCP-сервер `vibe` в `~/.workbuddy-ai/mcp.json`.
Любой MCP-клиент (код-агент) получает те же данные вызовами инструментов —
без запущенного дашборда и без ручного разбора `state.json`.

**Зачем.** Вместо «как узнать, какой файл трогать» агент делает один вызов и
получает сводку портфеля, карточку проекта, список аренд или готовый контекст
для новой сессии. Всё состояние читается с диска; `vibe serve` не нужен.

**12 инструментов** (`src/mcp.js`, stdio JSON-RPC 2.0, ноль зависимостей; версия `0.5.0`, +handoff):

| Инструмент | Зачем агенту |
|---|---|
| `vibe_status` | «Что сейчас в портфеле» за один вызов |
| `vibe_projects` | Список проектов с фильтром по стадии/флагу и сортировкой (по приоритету, скору, активности, имени) |
| `vibe_project` | Карточка одного проекта: скор по частям, флаги, git, какие клоны с ним связаны |
| `vibe_leases` | Кто держит какие файлы прямо сейчас |
| `vibe_lease_take` | Взять аренду перед правкой (`file` = `.` — проект целиком), чтобы не перетереть чужое |
| `vibe_lease_release` | Освободить аренду после правки |
| `vibe_dups` | Группы клонов (точные и похожие) с расхождением |
| `vibe_cleanup` | Что можно удалить и сколько места это освободит |
| `vibe_brief` | Готовый markdown-контекст для старта новой сессии (тот же, что кнопка «Контекст для новой сессии»); теперь пишет, кто работал последним |
| `vibe_refresh` | Пересчитать один проект (~0.2 с) вместо полного скана |
| `vibe_handoff_write` | Записать пакет передачи: кто работал и что сделал (чтобы следующий агент не начинал с нуля) |
| `vibe_handoff_read` | Прочитать последний пакет проекта: кто работал передо мной и что делал |

`vibe_lease_take`/`_release`, `vibe_refresh` и `vibe_handoff_write` пишут на диск и
дописывают журнал событий; остальные — read-only. Если MCP-клиент не подключен, те же
данные доступны из консоли (команды выше) и на дашборде (кнопки сценариев).

---

## Что делать, если…

| Симптом | Решение |
|---|---|
| `Панель не инициализирована` | `node bin/vibe.js init --root "<YOUR_PROJECTS_DIR>"` |
| `Состояние отсутствует` | Кнопка **Обновить данные** |
| Проект не находится | Проверьте `ignore` в настройках; каталоги `src`, `lib`, `app` внутри проекта проектами не считаются |
| Слишком много мусорных «проектов» | Поднимите «Мин. строк в клоне», добавьте маски в игнорируемые каталоги |
| Слишком много ложных похожих | Поднимите «Порог похожести» до 0.9 |
| Скан стал медленным | Поиск похожих занимает ~4 с; отключите через `"dup": { "near": false }` |
| Дашборд не обновляется | Проверьте, что лента живая (зелёная точка); SSE работает пока открыта вкладка |
| Порт занят | `node bin/vibe.js serve --port 5174` |

---

## Главное правило

**Правил код → `node tools/smoke.mjs` → задокументировал изменение.**

Несколько секунд на прогон, 227 проверок. Smoke-тест — единственное, что не даёт
документации разойтись с кодом.

---

# How to use the panel (English)

Open the dashboard, click a button, get the answer. Everything else (commands,
configs) is for agents and automation only.

```
node bin/vibe.js serve
```

Opens `http://127.0.0.1:5173`. If the port is busy: `node bin/vibe.js serve --port 5174`.

## The six buttons

At the top there is a **"What to do?"** block. Each button is a ready-made scenario;
the result appears right below the buttons.

| Button | What it does | What you get |
|---|---|---|
| **What needs a decision** | Leaves only problematic projects in the grid, sorted by priority | A list to start the morning with: duplicates, staleness, no git or tests |
| **Find similar files** | Filters duplicates to "similar" | Files that diverged across projects, with a divergence percentage |
| **What can be deleted** | Counts non-canonical exact copies | How many files and megabytes can be reclaimed, per project |
| **Refresh data** | Recomputes state from disk | Fresh numbers; progress shows in the live feed on the right |
| **Build a report** | Generates Markdown + HTML for all projects | Two link-buttons: open HTML or Markdown |
| **Context for a new session** | Collects a summary of the current state | Ready text — copy and paste as the first message to a new agent |

## Scenarios

### What needs a decision

The most useful button. The panel drops healthy projects and keeps those with flags:
duplicates, staleness, no git, no tests, uncommitted changes. Order is not random:
first the projects with the most problems, within that the lowest score. **Take the
first one and close flags one by one.**

Clicking a card expands the score breakdown: what was awarded and what was penalized.

### Find similar files

Not exact copies. These are files similar by minhash signature — usually a shared
module that diverged across projects. Each group header shows the **divergence
percentage**. The higher it is, the riskier "just delete the copy": needed code
might remain somewhere. Such files should be **compared**, not deleted.

Exact copies (0% divergence) are hidden here — there is the next button for them.

### What can be deleted

Shows only **exact** clones. In each group the panel picks a canon — the file to
keep (the project with the higher score and fresher activity). The other copies land
in the report. The table gives three things: how much is reclaimed (bytes and files,
per project); "entirely non-unique" projects (no copy became a canon — can be removed
whole, but first confirm a live canon exists elsewhere); and a clear note: **the panel
never deletes anything itself** — this is a list for your decision.

### Refresh data

Full recompute: directory walk, git, duplicates. Progress runs in the live feed; cards
update on their own. If you edited one project, a full scan is unnecessary — update it
separately from the console: `node bin/vibe.js refresh <name>` (fractions of a second
instead of ~11 s).

### Build a report

One file with everything: stages, what needs a decision, duplicates, deletion
candidates. Convenient to attach or return to later. Files land in `reports/`.

### Context for a new session

Solves the main pain: a dropped connection means a new session starting from zero.
The button collects a markdown summary: how many projects and in what state, **top
problematic ones with paths**, who holds leases, largest clone groups, deletion
candidates, and a three-step plan. For problematic projects the summary now has a line
**"↳ last worked by X (when): what they did"** — from handoff packages (see below).

Clicked "Copy" → pasted as the first message. The new agent is immediately in context.

The same without a browser: `node bin/vibe.js brief` from the console (or the MCP tool
`vibe_brief`) — the agent gets the same summary without raising the dashboard.

### Handoff between agents

A dropped connection should not reset work to zero. When an agent finishes (or hands a
project to another), it writes a package:

```bash
node bin/vibe.js handoff <project> --owner <you> --note "fixed dups in X, Y remains"
```

The record lands in `.vibe/handoffs.jsonl` (who, what, which files). The next agent
reads it with one command (or via MCP `vibe_handoff_read`) and immediately knows where
to start:

```bash
node bin/vibe.js handoff read <project>
# → Last session · <owner> (<when>): what they did
```

A single last record is not enough when agents work in parallel in neighboring
projects. So there is a feed:

```bash
node bin/vibe.js handoff read <project> --limit 5   # N latest packages for the project
node bin/vibe.js handoff read --all --limit 10      # cross-project feed across the portfolio
```

`--all` shows who did what in all projects — before this, you had to read
`.vibe/handoffs.jsonl` by hand.

Via MCP it is the same: `vibe_handoff_write` (requires `owner`) and `vibe_handoff_read`.
The agent's launch folder does not matter — shared `.vibe/` files and the global MCP
`vibe` are visible to all agents. This is coordination through the panel: no manual
copying of summaries between chats.

## What else is on the page

| Element | Why |
|---|---|
| Top cards | Overall summary: projects, average score, duplicate groups, reclaimable space |
| Search and sort | Find a project by name or path; sorts by priority, score, staleness, name |
| Stage chips S0–S5 | Filter by readiness: idea → prod |
| Live feed | What is happening right now: scan, leases, file changes. Green dot = live connection. Separately shows a **write under someone else's lease** |
| Leases | Who holds which file and how long until expiry |
| Suspicious project groups | Name-twins: `salebot`, `salebot-backup`, `salebot-next16` |
| File duplicates | Clone groups marked "canon" — what to keep, what is a copy |

## Settings

The **⚙ Settings** button in the header. Changed right in the browser, no restart.

| Field | Meaning |
|---|---|
| Scan roots | Which directories to walk. One path per line |
| Ignored directories | Globs, one per line. `node_modules`, `.git`, `dist` and other service dirs are always added |
| Lease TTL, minutes | How long a file lease lives. Default 30 |
| Similarity threshold | Sensitivity of similar-file search. `0.95` — only near-identical, `0.75` — more finds but also more false ones |
| Walk depth | How deep to descend into directories |
| Min lines in a clone | Shorter — not counted as a duplicate |

After changing roots or thresholds, click **Refresh data** — otherwise numbers stay old.

The same can be edited by hand in `.vibe/config.json`. Real keys:

```jsonc
{
  "roots": ["<YOUR_PROJECTS_DIR>"],
  "ignore": ["__to_delete__*", ".next-failed*"],
  "maxDepth": 8,
  "maxFilesPerProject": 20000,
  "staleDays": [30, 60, 180],
  "dup": { "minSize": 128, "maxSize": 262144, "minLines": 5, "near": true, "nearThreshold": 0.85 },
  "leases": { "ttlMinutes": 30 },
  "rating": { "weights": { "monetization": 0.6, "readiness": 0.4 } }
}
```

### Readiness score weights

The readiness score components are configurable — if "more code = more ready" does not
match your feeling, rework the split:

```jsonc
{
  "score": {
    "weights": {
      "idea": 10, "scaffold": 20, "core": 22, "tests": 20,
      "config": 10, "deploy": 8, "docs": 10
    }
  }
}
```

The sum need not be exactly 100, but it is desirable: the score is the sum of weights.
Missing keys come from the default; unknown ones are rejected with an error. After
editing, click **Refresh data**: the score is recomputed on scan.

The default split is calibrated on a real portfolio (see comments in `src/score.js` and
`tools/score-calib.mjs`): the "core" weight is lowered 25→22 (it saturated for 46% of
projects — the score turned into a code-volume measure), tests raised 15→20, deploy cut
10→8 (zero for 80% of projects — the weight did nothing).

## Console — for agents and automation

This is not done from the UI, hence here.

```bash
# Leases: so two agents don't overwrite one file
node bin/vibe.js lease <project> <file|.> --owner <name> [--ttl 30] [--reason "why"]
node bin/vibe.js release <project> <file> --owner <name>
node bin/vibe.js leases                 # active leases
node bin/vibe.js conflicts              # conflict log (incl. write under someone's lease)
node bin/vibe.js agents-md              # lease rules into AGENTS.md (+ CLAUDE.md shim)
node bin/vibe.js agents-md --project X  # same, but into project X's directory
node bin/vibe.js agents-md --no-shim    # only AGENTS.md, no CLAUDE.md
node bin/vibe.js agents-md --active [--dry-run] [--max-idle N]  # roll out to all suitable projects

# Handoff between agents
node bin/vibe.js handoff <project> --owner <you> [--note "what"] [--summary S] [--files f1,f2]
node bin/vibe.js handoff read <project> [--limit N]
node bin/vibe.js handoff read --all [--limit N]

# Context for session start from the console (same as the button and MCP vibe_brief)
node bin/vibe.js brief

# Targeted update instead of full scan
node bin/vibe.js refresh <name>         # ~0.2 s vs ~11 s
node bin/vibe.js watch                  # watch and recompute automatically

# Initial setup
node bin/vibe.js init --root "<YOUR_PROJECTS_DIR>"
node bin/vibe.js scan
```

### Write under someone else's lease

The filesystem does not report who changed a file, so the panel uses two sources and
honestly marks how reliable the event is:

| From | Sees | Looks like in the feed |
|---|---|---|
| Agent's PreToolUse hook | writer and holder | "Write under lease: X writes to a file held by Y" |
| `vibe watch` | holder only | "File under lease changed (held by Y, author unknown)" |

The hook is the precise source: it knows the writing agent's name (`VIBE_AGENT`). Its
fact also lands in `vibe conflicts`. Watch is a fallback for hook-less agents: the
holder could have edited the file themselves, so such events are marked unconfirmed.

Disabled with `leases.detectWrites: false` in `.vibe/config.json`; write frequency is
`leases.violationCooldownMs` (default 60 s per file).

## MCP — the panel as an agent tool

The panel is registered as the MCP server `vibe` in `~/.workbuddy-ai/mcp.json`. Any
MCP client (code-agent) gets the same data via tool calls — no running dashboard, no
manual `state.json` parsing.

**Why.** Instead of "how do I know which file to touch", the agent makes one call and
gets a portfolio summary, a project card, the lease list, or ready context for a new
session. All state is read from disk; `vibe serve` is not needed.

**12 tools** (`src/mcp.js`, stdio JSON-RPC 2.0, zero deps; version `0.5.0`, +handoff):
`vibe_status`, `vibe_projects`, `vibe_project`, `vibe_leases`, `vibe_lease_take`,
`vibe_lease_release`, `vibe_dups`, `vibe_cleanup`, `vibe_brief`, `vibe_refresh`,
`vibe_handoff_write`, `vibe_handoff_read`.

`vibe_lease_take`/`_release`, `vibe_refresh` and `vibe_handoff_write` write to disk and
append to the event log; the rest are read-only. If the MCP client is not connected,
the same data is available from the console (commands above) and on the dashboard
(scenario buttons).

## What to do if…

| Symptom | Solution |
|---|---|
| `Панель не инициализирована` (not initialized) | `node bin/vibe.js init --root "<YOUR_PROJECTS_DIR>"` |
| State missing | **Refresh data** button |
| Project not found | Check `ignore` in settings; `src`, `lib`, `app` inside a project are not projects |
| Too many junk "projects" | Raise "Min lines in a clone", add globs to ignored dirs |
| Too many false similar | Raise "Similarity threshold" to 0.9 |
| Scan became slow | Similar search takes ~4 s; disable with `"dup": { "near": false }` |
| Dashboard not updating | Check the live dot is green; SSE works while the tab is open |
| Port busy | `node bin/vibe.js serve --port 5174` |

## The main rule

**Edited code → `node tools/smoke.mjs` → documented the change.**

A few seconds per run, 227 checks. The smoke test is the only thing that keeps the
documentation from drifting from the code.
