# Архитектура панели вайбкодинга

Документ описывает **фактическое** состояние кода на 2026-08-31 (сессия 31, реализован Приоритет 2 — handoff-пакеты).
Как пользоваться панелью — `docs/USAGE.md`. Что сделано и что дальше — `PROGRESS.md`.

Если код и этот файл расходятся — правь код и этот файл вместе.

## Принципы

1. **Ноль зависимостей.** Только Node 22 stdlib. Ни npm-пакетов, ни нативной сборки.
   Причина: офлайн-среда, Windows, отсутствие toolchain. Любую фичу реализуем сами.
2. **Статус выводится из диска, а не вводится руками.** Ручной ввод протухает.
   Единственный рукописный файл — `.vibe/project.yaml` (метаданные самой панели).
3. **Append-only журнал.** `.vibe/events.jsonl` только дописывается; состояние
   `.vibe/state.json` полностью перезаписывается при каждом скане.
4. **Фронтенд не знает внутренней схемы.** Адаптация `state.json` → view-модель
   происходит в `buildView()` (`src/serve.js`).

## Слои

```
Команды (bin/vibe.js → src/cli.js)
        │
        ├── Сбор данных      src/scanner.js  src/detect.js  src/git.js
        ├── Дубли            src/dup.js      (minhash-подписи, LSH, near-группы)
        ├── Оценка           src/score.js
        ├── Состояние        src/store.js    (.vibe/state.json, .vibe/events.jsonl)
        ├── Инкремент        src/watch.js    (fs.watch + debounce → refresh проекта)
        ├── Представление    src/report.js   (статичные отчёты)
        │                    src/serve.js    (HTTP + SSE) → web/index.html
        └── Конфиг           src/config.js   (.vibe/config.json)
```

## Модули

| Файл | Ответственность | Ключевые точки входа |
|---|---|---|
| `bin/vibe.js` | Точка входа. Ловит ошибки, печатает `Ошибка: …`, выход 1. | `run(argv)` |
| `src/cli.js` | Разбор аргументов и все команды. Плюс запись правил агентов. | `init scan list show dup cleanup lease release leases conflicts agents-md refresh watch report stats serve handoff brief`, `writeAgentRules`, `findProjectEntry` (нужен MCP). **`brief` обязан быть в `COMMANDS`: на него ссылается раскатываемый `AGENTS.md`** |
| `src/rollout.js` | Отбор рабочих проектов для раскатки правил: без бэкапов/клонов/вложенных. Чистая функция (на вход — проекты, на выход — куда писать). | `pickRolloutTargets` (без бэкапов/клонов/вложенных), `foreignDupShare` (доля чужих канонов), `ROLLOUT_DEFAULTS` |
| `src/mcp.js` | MCP-сервер (M4): stdio JSON-RPC 2.0, 12 инструментов (v0.5.0, +handoff), читает состояние с диска. | `startMcpServer`, `handleMessage`, `listToolNames` |
| `src/handoff.js` | Handoff-пакеты (M4, Приоритет 2): append-only журнал передачи контекста между агентами. | `appendHandoff` (требует owner), `loadHandoffs`, `latestHandoffForProject`, `latestHandoffForTarget`, `recentHandoffs` (лента, `--limit`/`--all`) |
| `src/config.js` | Пути панели, ignore-листы, чтение/запись конфига. | `defaultConfig`, `loadConfig`, `compileIgnore` |
| `src/leases.js` | Аренды файлов (M3): advisory-локи с TTL, конфликты, журнал. | `acquireLease`, `releaseLease`, `activeLeases`, `findLease`, `recordConflict`, `readConflicts` |
| `src/pipeline.js` | Полный цикл сканирования, общий для CLI и дашборда. | `runScan(cfg, onProgress)` |
| `src/detect.js` | «Является ли каталог проектом», язык по расширению, стек. | `detectProjectKind`, `detectStack` |
| `src/scanner.js` | Трёхфазный обход: корни → метрики+хеши → near-дубли. Плюс пересчёт одного проекта. | `scan(cfg, onProgress)`, `collectProjectMetrics(path, cfg)` |
| `src/dup.js` | Near-дубли (уровень 2): нормализация с снятием комментариев, minhash, LSH-банды, union-find. | `analyzeNearDups(files, opts)`, `normalizeContent`, `minhashSignature`, `signatureSimilarity` |
| `src/git.js` | Git-состояние через `git` CLI, параллельно 6, таймаут 8 с. | `enrichWithGit(projects)` |
| `src/score.js` | Readiness 0–100, стадии S0–S5, флаги, приоритет. Веса компонентов настраиваемы. | `computeScore(p, weights)`, `normalizeScoreWeights`, `computeFlags`, `priorityOf` |
| `src/store.js` | Сборка состояния, канон и экономия групп, кэш подписей, журнал событий, инкрементальный refresh. | `buildState`, `buildCleanupReport`, `refreshProjectState`, `rebuildNearGroupsFromCache`, `loadSignatures`/`saveSignatures`, `appendEvent` |
| `src/watch.js` | Наблюдение за корнями: fs.watch recursive + поллинг `cheapMtime` (5 с), debounce, проект по длиннейшему префиксу. Плюс детектор записи под арендой. | `watchProjects({ cfg, state, onChange })`, `leasedFilesFor` |
| `src/write-hook.js` | PreToolUse-хук: атрибуция правок агенту и фиксация записи под чужой арендой. | `handlePreToolUse`, `extractWrittenPath` |
| `src/report.js` | Рендер Markdown и HTML. | `renderMarkdown`, `renderHtml`, `writeReports` |
| `src/serve.js` | HTTP-сервер, view-модель, SSE, конфиг-API, запуск скана, роуты сценариев. | `serve`, `buildView`, `buildLeasesView`, `buildCleanupView`, `buildBriefText`, `readLog`, `sanitizeConfigPatch` |
| `src/util.js` | Даты, числа, slug, пул параллелизма. | `formatAgo`, `formatNum`, `daysSince` |
| `web/index.html` | Дашборд: карточки, фильтры, лента SSE. | ванильный JS, без сборки |
| `tools/smoke.mjs` | Регрессионный тест (206 проверок). | `node tools/smoke.mjs` |
| `tools/score-calib.mjs` | Калибровка весов скора: насыщение и нули по компонентам. | `node tools/score-calib.mjs 10` |

## Поток данных

### Сканирование (`vibe scan`)

1. **Фаза A — `findProjectRoots()`.** Обход дерева до `maxDepth` (8). Каталог считается
   проектом, если есть сильный маркер (`package.json`, `pyproject.toml`, `go.mod`, …),
   `.sln/.csproj`, `.git` — либо два слабых (`Dockerfile` + `Makefile`), либо
   «точка входа + ≥2 файла кода», либо ≥4 файла кода.
   Защита от мусора: `NON_PROJECT_NAMES` (`src`, `lib`, `app`, `pages`, …) не считаются
   проектами внутри уже найденного проекта; флаг `parentIsProject` накапливается вниз по дереву.
2. **Фаза B — `collectMetrics()`.** Второй обход: считает файлы/строки/языки/тесты,
   хеширует исходники для поиска клонов. Каждый файл привязывается к ближайшему
   найденному корню проекта (`rootMap`), поэтому вложенные проекты не крадут метрики.
   Попутно собирает `dupMembers` — плоский список dup-eligible файлов для near-фазы.
3. **Фаза C — near-дубли (`analyzeNearDups` в `src/dup.js`).** Только для файлов, не
   попавших в точные группы: перечитывает файлы, снимает подписи, находит почти-клоны
   (см. «Поиск дублей», уровень 2). На ~50 проектах — ~4.5 с.
4. **Git — `enrichWithGit()`.** Для каталогов с `.git`: ветка, remote, незакоммиченные,
   worktree, дата последнего коммита. Ошибки глотаются (`git()` возвращает `null`).
5. **Сборка — `buildState()`.** Присваивает `id` (slug + дедуп), считает долю дублей,
   скор, стадию, флаги, приоритет. Пишет `.vibe/state.json`, добавляет событие в журнал.
   `cmdScan` дописывает в `state.scan` время git (`gitMs`) и полного цикла (`totalMs`).

### Поиск дублей

**Уровень 1 — точные клоны** (`src/scanner.js`):

- Нормализация `normalizeContent()` (`src/dup.js`): снимает BOM, `\r\n` → `\n`, пустые
  строки, хвостовые пробелы **и комментарии по языку** (`//`, `/* */`, `#`, `<!-- -->`).
  Файлы, отличающиеся только комментариями, считаются клонами.
- `sha256` по нормализованному тексту. Группа = хеш с ≥2 файлами.
- Фильтры размера: `dup.minSize` 128 Б, `dup.maxSize` 256 КБ, `dup.minLines` 5.

**Уровень 2 — почти-клоны** (`src/dup.js`):

- Участники: dup-eligible файлы (те же фильтры, расширения из `DUP_EXTENSIONS`),
  не вошедшие в точные группы.
- Подпись: shingle = 5 слов, minhash n=48. Строки перестановок — числовой микс
  базового FNV-1a хеша шингла (без аллокаций строк). Файлы >40 000 токенов пропускаются.
- Кандидаты через LSH: подпись режется на 16 полос по 3 строки; совпала целая полоса —
  кандидатная пара (бакеты >12 файлов считаются шаблонным шумом и пропускаются).
- Похожесть ≥ `dup.nearThreshold` (0.85) → union-find → кластеры = near-группы.
  Канон — член с максимальной суммарной похожестью; `drift = 1 − similarity`.
- Ограничение: minhash — аппроксимация; тексты, различающиеся парой строк, могут дать
  sim ≈ 1. Пары «различие видно» ловит только уровень 1.

**Общий список**: точные и near-группы сортируются вместе по весу
`копии × строки × (near ? similarity : 1)`. `crossProject` — файлы в разных проектах.

### Кандидаты на удаление (`vibe cleanup`)

- Канон группы размечается в `buildState` (schema 3): двухпроходная сборка — сначала
  скор проектов без учёта дублей (разрыв цикла «канон ← скор ← дубли»), затем
  `markCanonicalInGroup()`: канон = максимум скора, при равенстве — свежее.
  В группу пишутся `isCanonical` у членов и `wastedBytes`/`wastedLines` (объём
  неканонических копий).
- `buildCleanupReport(state, {kind, minBytes})` агрегирует: итог, разбивку по проектам,
  «целиком неуникальные» проекты (в группах которых нет ни одного канона) и вес
  почти-дублей отдельно. По умолчанию `kind: 'exact'` — near-копии удалять нельзя.
- Панель ничего не удаляет: команда и отчёты только показывают решения.
- После `vibe refresh` канон перемечается в `rebuildDupGroupsForProject` — состав
  групп мог измениться.

### Инкрементальный пересчёт (`vibe refresh`, `vibe watch`, `vibe serve --watch`)

- `collectProjectMetrics(path, cfg)` (`src/scanner.js`) — полный пересчёт одного проекта:
  вложенные корни ищутся заново (владение файлами совпадает с полным сканом), метрики,
  маркеры, стек, Map хешей и dup-список файлов.
- `refreshProjectState(state, path, cfg)` (`src/store.js`) — пересчитывает проект, git,
  группы клонов, `dupLines/dupShare/скор/стадию/флаги/приоритет`, обновляет `generatedAt`.
- **Near-группы по кэшу подписей** (`rebuildNearGroupsFromCache`): полный скан сохраняет
  minhash-подписи всех near-кандидатов в `.vibe/signatures.json` (метаданные + 48 чисел,
  без текстов). Refresh берёт чужие подписи из кэша, подписи пересчитываемого проекта
  строит заново и прогоняет общий LSH — near-группы пересобираются целиком за ~0.4 с
  без чтения чужих файлов. Если кэша нет (первый запуск), near-группы не трогаются.
- Точные группы: `rebuildDupGroupsForProject` пересобирает группы с участием проекта
  и перемечает канон. Ограничение: пары «файл проекта ↔ чужой одиночный файл», которых
  не было в группах на момент полного скана, инкремент не находит — их покажет `vibe scan`.
- `watchProjects()` (`src/watch.js`) — `fs.watch` recursive по корням (Windows/macOS)
  **плюс поллинг `cheapMtime` каждые 5 с** (корень + `.git/index`: ловит коммиты и
  работает без recursive-watch), игнорирует служебные каталоги (`compileIgnore`),
  находит проект по длиннейшему префиксу, дебаунс 1.2 с, по одному проекту за раз.
  `vibe watch` и `vibe serve --watch` после каждого пересчёта пишут `state.json` —
  дашборд подхватывает через SSE.

### Детектор записи под чужой арендой (Приоритет 3)

Два источника, потому что файловая система **не сообщает, кто изменил файл**:

| Источник | Что знает | Событие |
|---|---|---|
| `handlePreToolUse` (`src/write-hook.js`) | писатель (`VIBE_AGENT`) и держатель | `lease.violation`, `confirmed: true` |
| `watchProjects` (`src/watch.js`) | только держателя | `lease.violation`, `confirmed: false` |

**Хук — точный канал.** Агент вызывает его перед записью; если файл уже под
арендой другого — факт пишется и в `.vibe/conflicts.jsonl` (тип `write-under-lease`),
и в ленту (`lease.violation`, `confirmed: true`, `requester` — реальный писатель).
Раньше хук молча возвращал `leased` и приписывал активность держателю — реальный
автор правки оставался неизвестен.

**Watch — резервный канал.** Работает для агентов без хука. Если изменённый файл
покрыт активной арендой, `leasedFilesFor()` возвращает держателя, и в ленту
уходит `lease.violation` с `confirmed: false`. Держатель мог править и сам,
поэтому событие читается как «файл под арендой меняли, автор не подтверждён».
Дедуп — `leases.violationCooldownMs` (60 с) на пару проект+путь; отключается
флагом `leases.detectWrites: false`.

Оба события описывает `describeEvent()` (`src/serve.js`) — лента дашборда
показывает их разными фразами.

### Веб-дашборд (`vibe serve`)

```
GET  /                → web/index.html
GET  /reports/<файл>  → отчёт из reports/ (имя через path.basename, обход каталога закрыт)
GET  /api/state       → buildView(loadState()) + leases + conflictsCount + readLog()
GET  /api/config      → конфиг (мержится с дефолтами) + panelRoot + статус скана
POST /api/config      → валидирующий патч (sanitizeConfigPatch) → saveConfig → событие
GET  /api/scan        → { running, startedAt, error }
POST /api/scan        → runScan на сервере (409, если уже идёт); прогресс — в ленту SSE
GET  /api/cleanup     → buildCleanupView(): ?kind=exact|near, ?minBytes=N
POST /api/report      → writeReports() → { mdPath, htmlPath, mdUrl, htmlUrl }
GET  /api/brief       → buildBriefText(): markdown-сводка для новой сессии агента
GET  /api/events      → SSE: hello → log/refresh (fs.watch на state.json и leases.json)
прочее                → 404
```

Три роута (`/api/cleanup`, `/api/report`, `/api/brief`) существуют для кнопок-сценариев
в блоке «Что сделать?» — см. `docs/USAGE.md`. `POST /api/report` пишет два файла за вызов;
любой автотест обязан их удалять.

События SSE: `hello` (при подключении), `log` (запись в ленту), `refresh` (состояние
изменилось — фронтенд перезапрашивает `/api/state`). Heartbeat `: ping` каждые 15 с.
SSE-клиенты регистрируются в общем реестре — прогресс фонового скана броадкастится всем.
Сервер слушает только 127.0.0.1: POST-роуты конфига/скана доступны лишь локально.

## Модель скоринга (`src/score.js`)

Скор 0–100 складывается из семи компонентов. Максимум каждой задаётся **весом**
(сумма весов по умолчанию = 100); веса настраиваются через `config.score.weights`.

| Компонент | Вес (дефолт) | Из чего |
|---|---:|---|
| `idea` — замысел | 10 | README (6) + spec/docs (4) |
| `scaffold` — каркас | 20 | манифест или стек (8) + lockfile (5) + есть код (7) |
| `core` — ядро | 22 | `0.5·min(1, codeFiles/40) + 0.5·min(1, loc/5000)` |
| `tests` — тесты | 20 | есть тесты (8) + фреймворк в стеке (4) + ≥3 тест-файла (3) |
| `config` — конфигурация | 10 | `.env.example` (4) + config (3) + `.gitignore` (3) |
| `deploy` — запуск | 8 | Docker (4) + CI (3) + скрипт запуска (3) |
| `docs` — документация | 10 | README (5) + AGENTS.md/CLAUDE.md (5) |

Считается как «доля компоненты × её вес», поэтому `scoreParts` (их печатают CLI,
MCP и дашборд) всегда в тех же единицах, что и скор.

**Константы** (`src/score.js`): `PART_MAX` — максимум «сырых» баллов формулы
(нужен для пересчёта доли), `DEFAULT_SCORE_WEIGHTS` — веса по умолчанию,
`CORE_SATURATION` — пороги насыщения ядра. `normalizeScoreWeights(raw)`
дополняет пользовательские веса дефолтными и отбрасывает мусор.

**Раскладка отклибрована 2026-09-06** на реальном портфеле: вес `core` снижен 25→22
(насыщался у 46 % проектов — скор превращался в измерение объёма кода), `tests`
поднят 15→20, `deploy` урезан 10→8 (у 80 % проектов там ноль). Пороги ядра
подняты с 20 файлов/2000 строк до 40/5000 — насыщение `core` упало до 29 %.
Перекалибровать: `node tools/score-calib.mjs [N]`.

**Штрафы:** застой >180 дн. −25, >120 дн. −20, >60 дн. −15; доля дублей >20 % −10;
нет git −5. Итог обрезается в диапазон 0–100.

**Стадии:** S0 Идея (<20), S1 Каркас (<40), S2 Альфа (<60), S3 Бета (<80),
S4 Готово (<95), S5 Прод (≥95).

**Флаги:** `stale`, `nogit`, `noremote`, `dirty`, `noreadme`, `notests`, `dups`, `orphan`.

**Приоритет** `priorityOf()`: `флаги × 12 + (100 − скор) × 0.5 + свежесть (≤14 дн. → +15)
+ застой (min(20, дней/12))`. Чем выше — тем раньше проект попадается на глаза.

## Форматы данных

### `.vibe/config.json`

```jsonc
{
  "schema": 1,
  "roots": ["<YOUR_PROJECTS_DIR>"],
  "ignore": ["node_modules", ".git", ".next-failed*", "__to_delete__*", "*.egg-info"],
  "ignoreFiles": ["package-lock.json", "yarn.lock"],
  "maxDepth": 8,
  "maxFilesPerProject": 20000,
  "staleDays": [30, 60, 180],
  "dup": { "minSize": 128, "maxSize": 262144, "minLines": 5,
           "near": true, "nearThreshold": 0.85 },
  "leases": { "ttlMinutes": 30 },
  "rating": { "weights": { "monetization": 0.6, "readiness": 0.4 } },
  "monetization": { "<id или путь>": { "value": 0..100 } },
  "score": { "weights": { "idea": 10, "scaffold": 20, "core": 22, "tests": 20,
                          "config": 10, "deploy": 8, "docs": 10 } }
}
```

`ignore` поддерживает маски с `*`. При загрузке конфиг мержится с `DEFAULT_IGNORE`,
поэтому новые правила классификации доезжают в уже созданный файл. Служебные каталоги
`reports`, `outputs`, `.local` игнорируются — иначе они забивают дубли и искажают экономию.
Параметры near-уровня: `dup.near` (вкл/выкл фазы C) и `dup.nearThreshold` (порог
похожести подписей, 0.85).

`score.weights` — веса компонентов readiness-скора. Отсутствующие ключи берутся из
`DEFAULT_SCORE_WEIGHTS`; неизвестные компоненты и нечисловые значения отклоняет
`sanitizeConfigPatch`. Скор пересчитывается при скане, так что после правки весов
нужен `vibe scan`.

**Маркеры проекта** (`has{}`) заполняет `applyMarkers()` в `src/scanner.js` по именам
непосредственных потомков. Ловушки, уже стоившие бола: `package-lock.json` не
матчится regexp'ом вида `/(lock)$/` (имя кончается на `.json`), а `.github` —
не `github` (точка в имени).

### `.vibe/state.json`

```
{
  schema: 3, generatedAt, roots[],
  scan{ dirsVisited, projectsFound, dupGroupsFound, exactGroupsFound,
        nearGroupsFound, nearDupMs, elapsedMs, gitMs, totalMs },
  projects[] {
    id, name, path, stack[], detectedReason, files, codeFiles, testFiles, loc, bytes,
    locByLang{}, has{ readme, docs, spec, tests, ci, docker, envExample, config,
                      gitignore, agentContext, lockfile, git, remote },
    names[], truncated, git{ branch, remote, lastCommitAt, uncommitted, worktrees } | null,
    lastActivityAt, scannedAt, dupLines, dupShare,
    score, scoreBase, scoreParts{}, scorePenalties[], stage, stageLabel, flags[], priority
  },
  dupGroups[] {
    id, kind: 'exact'|'near',
    hash (у exact; null у near), similarity, drift,
    wastedBytes, wastedLines,
    lines, size, projectCount, crossProject,
    members[]{ projectId, projectPath, rel, size, lines, sim (только near),
               isCanonical: bool }
  }
}
```

`dupLines` проекта суммирует строки из групп обоих видов. Канон размечается в
`buildState`: канонная копия — проект с наибольшим скором (без учёта дублей), при
равенстве — более свежий. `wastedBytes` — суммарный размер неканонических копий группы.

### `.vibe/events.jsonl`

По строке на событие: `{ ts, type, fingerprint, payload }`.
`fingerprint` = первые 16 hex символов sha256 от `type|JSON(payload)`.
Дедуп на записи: `appendEvent` читает журнал и не пишет событие, чей fingerprint
уже есть. Ротация: при >600 строк журнал обрезается до последних 400.

### `.vibe/signatures.json`

Внутренний кэш near-анализа: `{ generatedAt, entries[]{ file{ project, rel, path, ext,
size, lines }, sig[48] } }`. Пишется полным сканом и refresh'ем; читается инкрементальной
пересборкой near-групп. Не часть состояния панели.

### `.vibe/leases.json` и `.vibe/conflicts.jsonl`

Аренды: `{ schema, leases[]{ id, project, rel, owner, reason, acquiredAt, expiresAt, ttlMs } }`
(перезаписывается при каждой операции). Конфликты — по строке на событие:
`{ ts, type: 'blocked'|'forced', project, rel, holder, requester, note }`.

### Handoff-пакеты (M4, Приоритет 2, `vibe handoff` / `vibe_handoff_write` / `vibe_handoff_read`)

Передача контекста между агентами **без ручного копирования**. Агент, завершивший работу,
пишет пакет: кто работал (`owner`), что сделал (`note`/`summary`), какие файлы тронул
(`files`). Следующий агент читает последний пакет проекта и сразу в контексте — обрыв
связи не сбрасывает работу в ноль.

Хранилище — append-only `.vibe/handoffs.jsonl`, по строке на запись:

```
{ ts, projectId, projectPath, projectName, owner, note, summary, files[] }
```

- `ts` — время записи (ms). `owner` **обязателен**: без него `appendHandoff` бросает ошибку
  (защита от анонимных записей, за которыми не видно, кто работал).
- Резолв проекта — по трём ключам в порядке приоритета: `projectId` → `projectPath`
  (нормализованный через `path.resolve`) → `projectName` (lowercase). `latestHandoffForTarget`
  возвращает **последнюю** запись, подходящую по любому из ключей (побеждает свежая).
- Ротация: при >600 строк журнал обрезается до последних 400 (как у `events.jsonl`).
- Интеграция с brief: `buildBriefText` (`/api/brief`, кнопка «Контекст для новой сессии»)
  подтягивает последний handoff каждого flagged-проекта и в разделе «Требуют решения»
  печатает `↳ последний работал <owner> (<когда>): <что сделал>`.
- Команды CLI: `vibe handoff <проект> --owner <ты> [--note S] [--summary S] [--files f1,f2]`
  и `vibe handoff read <проект>`. Через MCP — `vibe_handoff_write` / `vibe_handoff_read`.
- **Лента вместо одной записи.** `vibe handoff read <проект> --limit N` — N последних
  пакетов проекта; `vibe handoff read --all [--limit N]` — кросс-проектная лента по
  всему портфелю (`recentHandoffs`, новые сверху). Без этого активность агентов в
  соседних проектах была принципиально не видна — приходилось читать `handoffs.jsonl`
  руками. Одиночный вывод (без `--limit`) сохранён для обратной совместимости.
- **`vibe brief`** — CLI-двойник MCP-инструмента `vibe_brief` и кнопки дашборда: та же
  сводка (`buildBriefText`) без запущенного сервера. Регистрация `brief: cmdBrief` в
  `COMMANDS` обязательна: на команду ссылается текст `AGENTS.md`, раскатываемый по
  всем проектам — отсутствие команды давало агентам «Неизвестная команда».

### Контракт `/api/state` (view-модель)

Фронтенд получает НЕ `state.json`, а адаптированную модель из `buildView()`:

```
{
  scannedAt, summary{ total, withGit, withTests, stale60, dupWastedBytes, nearWastedBytes },
  dupKinds{ all, exact, near },
  projects[]{ id, name, path, stage, stageLabel, score, stack[], isGit, hasTests,
              testFiles, loc, files, staleDays, lastActivityMs, lastActivityAt,
              git, breakdown{}, penalties[], dup{ files, total, ratio }, flags[] },
  dupGroups[]{ label, kind, drift, similarity, wastedBytes, crossProject,
               members[]{ projectName, projectPath, rel, lines, size, isCanonical } },
  projectDupGroups[]{ key, members[]{ name, stage, score, isCanonical } },
  leases[]{ id, projectName, rel, owner, reason, acquiredAt, expiresAt, leftMs, whole },
  conflictsCount,
  log[]{ ts, text }
}
```

`dupGroups` содержит до 30 точных и до 30 похожих групп порознь — топ по весу
вытеснял near-группы, и фильтр «похожие» на фронте оставался пустым.
`dupKinds` — счётчики по всему состоянию (для чипов-фильтров).

Отличия от внутренней схемы: `scoreParts.idea` → `breakdown.vision`,
`flags[].{code,label}` → `flags[].{kind,text}`. Каноническая копия в группе —
проект с наибольшим скором, при равенстве — более свежий. `kind`/`drift`/`similarity`
берутся из состояния: фронтенд подписывает группу «точная копия» либо
«похожий · расхождение N%».

### Аренды файлов (M3, `vibe lease` / `release` / `leases` / `conflicts` / `agents-md`)

- **Advisory-локи по паттерну Beads.** Аренда добровольная: агент берёт её перед правкой
  (правила генерирует `vibe agents-md`, см. ниже),
  панель ничего не блокирует на уровне ФС — гарантией является то, что следующий
  `lease` на занятый файл отклоняется.
- **Ключ** = проект + относительный путь (`.` — весь проект, пересекается с любой
  арендой проекта). Аренда одного владельца на том же ключе обновляется, а не дублируется.
- **TTL** (`leases.ttlMinutes`, 30): просроченная аренда не возвращается из
  `activeLeases()` и снимается при следующем take — брошенных локов не бывает.
- **Конфликты**: блокировка запроса, перехват (`--force`) и запись под чужой
  арендой (`write-under-lease`) пишутся в `.vibe/conflicts.jsonl`
  (append-only, ротация 300→200) с указанием держателя и просителя.
- Настройки детектора: `leases.detectWrites` (вкл/выкл канал watch) и
  `leases.violationCooldownMs` (дедуп, 60 с).
- Время везде передаётся параметром `now` — модуль тестируется без задержек.
- Дашборд: `/api/state` несёт `leases[]` (с `leftMs`) и `conflictsCount`; SSE следит
  и за `leases.json`.

### Правила для агентов (`vibe agents-md` → `writeAgentRules`)

Записывает блок правил аренд между маркерами `vibe:leases:start` / `vibe:leases:end`.
Повторный запуск заменяет блок, а не дописывает второй.

**Три файла из одного источника.** Агенты читают разные файлы инструкций, поэтому
`writeAgentRules(dir, panelRoot, projectName, { withShim = true, withGemini = true })` пишет:

| Файл | Содержимое | Кто читает |
|---|---|---|
| `AGENTS.md` | источник истины: полный блок правил + путь к CLI | OpenCode, Codex, ZCode |
| `CLAUDE.md` | тонкая прокладка: одна строка `@AGENTS.md` | Claude Code |
| `GEMINI.md` | тонкая прокладка: одна строка `@AGENTS.md` | Gemini CLI, Antigravity («gemeny») |

Claude Code **не** читает `AGENTS.md` нативно (issue #6235 закрыт без поддержки),
зато понимает `@`-импорты — поэтому правила не дублируются, а подключаются ссылкой.
Gemini CLI и Antigravity (IDE Google на базе Gemini) читают `GEMINI.md` и тоже
понимают `@`-импорт — отсюда вторая прокладка с тем же содержимым.
Симлинк не годится: на Windows он требует прав администратора или режима разработчика.
`--no-shim` отключает создание `CLAUDE.md`, `--no-gemini` — создание `GEMINI.md`
(на случай, если какая-то прокладка не нужна).

WorkBuddy читает правила из собственного профиля (`SOUL.md`/`IDENTITY.md`) —
что он делает с `AGENTS.md` в каталоге проекта, по коду не подтверждено.

### Массовая раскатка (`vibe agents-md --active`)

Одна команда пишет правила сразу во все подходящие рабочие проекты. Отбор
(`pickRolloutTargets` в `src/rollout.js`) исключает:

- корень сканирования (это контейнер, а не проект);
- бэкапы/копии/мусор по имени и пути (`backup`, `-consolidation-`, `_source_copy`,
  `clean_dist`, `node_modules`, `_audit_tmp`, `_staging`, …);
- застаревшие (нет активности > `maxIdleDays`, 14 дн.);
- **клоны** — не по `dupShare` (доля строк в дублях: у живого источника она тоже
  1.0), а по `foreignDupShare` (доля строк, где каноном назначен *другой* проект).
  Живые источники дают 0.6…0.8, клоны — 0.97…1.0; порог `maxForeignDup` = 0.9
  чётко делит;
- вложенные проекты: агенты ищут `AGENTS.md` вверх по дереву, поэтому родительский
  файл покрывает ребёнка.

Ключи: `--active` (раскатить вместо одного проекта), `--dry-run` (только показать
отобранные и пропущенные с причиной), `--max-idle N`. Результат: ≈24 из ~50
обновлены, 27 пропущены с причиной в консоли. Повторный запуск заменяет блок
(маркеры `vibe:leases:*`), не дублирует; существующие `AGENTS.md`/`CLAUDE.md`
дописываются, не затираются.

## MCP-сервер панели (M4)

`src/mcp.js` + `bin/vibe-mcp.js` — stdio JSON-RPC 2.0, **ноль зависимостей**,
newline-delimited. Панель как инструмент для любого MCP-клиента (код-агента).

**Зачем не HTTP-роуты.** Агент поднимает контекст проекта за один вызов инструмента,
а не угадывает, какие файлы трогать. Всё состояние читается с диска — запущенный
`vibe serve` не нужен, сервер можно поднять в любой сессии любого агента.

**Транспорт.** stdout — только протокол (одна JSON-строка на сообщение). Логи и
диагностика — в stderr, иначе клиент не разберёт ответ. Уведомления
(`notifications/*`, без `id`) ответа не требуют. Ошибки инструмента возвращаются
как `result.isError: true`; ошибки протокола — в поле `error` (`-32601` метод,
`-32602` неизвестный инструмент, `-32700` парсинг, `-32603` внутренняя).

**Ловушка stdio.** Выход по `stdin.end` до завершения асинхронных `tools/call`
теряет последние ответы. Решено счётчиком `pending` + `ended`: процесс завершается
в `finishIfDone()` только когда `ended && pending === 0`.

**Регистрация.** В `~/.workbuddy-ai/mcp.json` добавлен ключ `vibe`:

```jsonc
{
  "vibe": {
    "command": "<NODE_BINARY>",
    "args": ["<REPO_ROOT>/bin/vibe-mcp.js"],
    "cwd": "<REPO_ROOT>",
    "env": { "NODE_NO_WARNINGS": "1" }
  }
}
```

Старые 6 серверов (freelance-combine, flru, kwork, upwork, habr-career, …) не тронуты.

> **Ловушка:** managed-Node обновляется, и зашитый в `mcp.json` путь превращается
> в ENOENT — сервер молча недоступен агентам (было: `22.22.2-1` → стало
> `22.22.2-2`). После обновления рантайма проверять
> `ls ~/.workbuddy-ai/binaries/node/versions/` и править `mcp.json`.

**12 инструментов** (`PROTOCOL_VERSION = '2024-11-05'`, `serverInfo.name = 'vibe-panel'`, версия `0.5.0`; +`vibe_handoff_write`/`vibe_handoff_read`):

| Инструмент | Что делает | Аргументы |
|---|---|---|
| `vibe_status` | Сводка портфеля: проекты, стадии, клоны, аренды, сколько требует решения | — |
| `vibe_projects` | Список проектов с фильтрами | `stage` (S0…S5), `flag`, `sort` (priority/score/activity/name), `limit` |
| `vibe_project` | Карточка проекта: скор по частям, флаги, git, клоны | `name` (обязателен) |
| `vibe_leases` | Активные аренды файлов | — |
| `vibe_lease_take` | Взять аренду перед правкой | `project`, `file` (`.` = проект целиком), `owner`, `ttl`, `reason`, `force` |
| `vibe_lease_release` | Освободить аренду | `project`, `file`, `owner` |
| `vibe_dups` | Группы клонов (точные и похожие) | `kind` (all/exact/near), `limit` |
| `vibe_cleanup` | Кандидаты на удаление | `kind` (exact/near), `minBytes`, `limit` |
| `vibe_brief` | Готовый контекст для новой сессии (как кнопка на дашборде) | — |
| `vibe_refresh` | Пересчитать один проект (~0.2 с) вместо полного скана | `name` (обязателен) |
| `vibe_handoff_write` | Записать handoff-пакет: кто работал и что сделал (передача контекста следующему агенту) | `project` (обязателен), `owner` (обязателен), `note`, `summary`, `files[]` |
| `vibe_handoff_read` | Прочитать последний handoff-пакет проекта (кто работал передо мной и что делал) | `project` (обязателен) |

`vibe_lease_take`/`_release`, `vibe_refresh` и `vibe_handoff_write` пишут на диск
(`.vibe/leases.json`, `.vibe/state.json`, `.vibe/handoffs.jsonl`) и дописывают журнал
событий. Остальные — read-only.
`vibe_refresh` использует `refreshProjectState` из `src/store.js`, поэтому near-группы
пересобирает по кэшу подписей (см. «Инкрементальный пересчёт»).

`listToolNames()` экспортируется для smoke-теста и этой документации.

## Границы

- **Windows-only по факту.** tmux нет; активность считается по mtime файлов и коммитам.
  Кириллица в путях работает: git вызывается с `-c core.quotepath=false`.
  `fs.watch` recursive в `vibe watch` — Windows/macOS; на Linux увидел бы только верхний уровень.
- **Полный цикл ~12 с** на ~50 проектов / ~5 800 каталогов (скан ~7 с + near-dup ~4.5 с +
  git ~1 с). Первый прогон на холодном дисковом кэше — до минуты.
- **Нет SQLite.**   JSON-файл целиком перезаписывается. На типичном объёме (~50 проектов, ~0.5 МБ)
  это быстрее и проще; переход на SQLite WAL запланирован, схема — в истории репозитория.
- **minhash — аппроксимация**: near-группа с sim=1 не гарантирует идентичность текстов.

---

# Architecture (English)

This document describes the **actual** state of the code (current as of 2026-09-06) —
handoff packages and the panel's MCP server are implemented.
How to use the panel — `docs/USAGE.md`. Overview and quick start — `README.md`.

If the code and this file diverge, fix both together.

## Principles

1. **Zero dependencies.** Node 22 stdlib only. No npm packages, no native build.
   Reason: offline environment, Windows, no toolchain. Every feature is implemented in-house.
2. **Status is derived from disk, never typed by hand.** Manual input goes stale.
   The only hand-written file is `.vibe/project.yaml` (the panel's own metadata).
3. **Append-only log.** `.vibe/events.jsonl` is only appended; `.vibe/state.json`
   is fully rewritten on each scan.
4. **The frontend knows nothing about the internal schema.** Adapting `state.json`
   → view-model happens in `buildView()` (`src/serve.js`).

## Layers

```
Commands (bin/vibe.js → src/cli.js)
        │
        ├── Collection      src/scanner.js  src/detect.js  src/git.js
        ├── Duplicates      src/dup.js      (minhash signatures, LSH, near-groups)
        ├── Scoring         src/score.js
        ├── State           src/store.js    (.vibe/state.json, .vibe/events.jsonl)
        ├── Incremental     src/watch.js    (fs.watch + debounce → refresh a project)
        ├── Presentation    src/report.js   (static reports)
        │                   src/serve.js    (HTTP + SSE) → web/index.html
        └── Config          src/config.js   (.vibe/config.json)
```

## Modules

| File | Responsibility | Key entry points |
|---|---|---|
| `bin/vibe.js` | Entry point. Catches errors, prints `Ошибка: …`, exit 1. | `run(argv)` |
| `src/cli.js` | Arg parsing and all commands. Plus agent-rule writing. | `init scan list show dup cleanup lease release leases conflicts agents-md refresh watch report stats serve handoff brief`, `writeAgentRules`, `findProjectEntry`. **`brief` must stay in `COMMANDS`: the rolled-out `AGENTS.md` references it** |
| `src/rollout.js` | Selecting working projects for rule rollout. Pure function. | `pickRolloutTargets`, `foreignDupShare`, `ROLLOUT_DEFAULTS` |
| `src/mcp.js` | MCP server (M4): stdio JSON-RPC 2.0, 12 tools (v0.5.0, +handoff), reads state from disk. | `startMcpServer`, `handleMessage`, `listToolNames` |
| `src/handoff.js` | Handoff packages (M4): append-only context-transfer log between agents. | `appendHandoff` (requires owner), `loadHandoffs`, `latestHandoffForProject`, `latestHandoffForTarget`, `recentHandoffs` |
| `src/config.js` | Panel paths, ignore lists, config read/write. | `defaultConfig`, `loadConfig`, `compileIgnore` |
| `src/leases.js` | File leases (M3): advisory locks with TTL, conflicts, log. | `acquireLease`, `releaseLease`, `activeLeases`, `findLease`, `recordConflict`, `readConflicts` |
| `src/pipeline.js` | Full scan cycle, shared by CLI and dashboard. | `runScan(cfg, onProgress)` |
| `src/detect.js` | "Is this a project", language by extension, stack. | `detectProjectKind`, `detectStack` |
| `src/scanner.js` | Three-phase walk: roots → metrics+hashes → near-dups. Plus single-project recompute. | `scan(cfg, onProgress)`, `collectProjectMetrics(path, cfg)` |
| `src/dup.js` | Near-dups (level 2): comment-stripping normalization, minhash, LSH bands, union-find. | `analyzeNearDups(files, opts)`, `minhashSignature`, `signatureSimilarity` |
| `src/git.js` | Git state via `git` CLI, parallelism 6, timeout 8 s. | `enrichWithGit(projects)` |
| `src/score.js` | Readiness 0–100, stages S0–S5, flags, priority. Component weights configurable. | `computeScore(p, weights)`, `normalizeScoreWeights`, `computeFlags`, `priorityOf` |
| `src/store.js` | State assembly, canon and savings per group, signature cache, event log, incremental refresh. | `buildState`, `buildCleanupReport`, `refreshProjectState`, `rebuildNearGroupsFromCache`, `appendEvent` |
| `src/watch.js` | Watch roots: fs.watch recursive + `cheapMtime` poll (5 s), debounce, project by longest prefix. Plus write-under-lease detector. | `watchProjects({ cfg, state, onChange })`, `leasedFilesFor` |
| `src/write-hook.js` | PreToolUse hook: attribute edits to an agent and record writes under someone else's lease. | `handlePreToolUse`, `extractWrittenPath` |
| `src/report.js` | Render Markdown and HTML. | `renderMarkdown`, `renderHtml`, `writeReports` |
| `src/serve.js` | HTTP server, view-model, SSE, config API, scan trigger, scenario routes. | `serve`, `buildView`, `buildLeasesView`, `buildCleanupView`, `buildBriefText`, `readLog`, `sanitizeConfigPatch` |
| `src/util.js` | Dates, numbers, slug, parallelism pool. | `formatAgo`, `formatNum`, `daysSince` |
| `web/index.html` | Dashboard: cards, filters, SSE feed. | vanilla JS, no build |
| `tools/smoke.mjs` | Regression test (227 checks). | `node tools/smoke.mjs` |
| `tools/score-calib.mjs` | Calibrate score weights: saturation and zeros per component. | `node tools/score-calib.mjs 10` |

## Data flow

### Scanning (`vibe scan`)

1. **Phase A — `findProjectRoots()`.** Tree walk to `maxDepth` (8). A directory is a
   project if it has a strong marker (`package.json`, `pyproject.toml`, `go.mod`, …),
   `.sln/.csproj`, `.git` — or two weak markers (`Dockerfile` + `Makefile`), or
   "entry point + ≥2 code files", or ≥4 code files. Guard against junk: `NON_PROJECT_NAMES`
   (`src`, `lib`, `app`, …) are not projects inside an already-found project.
2. **Phase B — `collectMetrics()`.** Second walk: counts files/lines/languages/tests,
   hashes sources for clone search. Each file binds to the nearest found project root
   (`rootMap`), so nested projects don't steal metrics.
3. **Phase C — near-dups (`analyzeNearDups` in `src/dup.js`).** Only files not in exact
   groups: re-reads, strips signatures, finds near-clones. ~4.5 s on ~50 projects.
4. **Git — `enrichWithGit()`.** For directories with `.git`: branch, remote, uncommitted,
   worktree, last-commit date. Errors are swallowed (`git()` returns `null`).
5. **Assembly — `buildState()`.** Assigns `id` (slug + dedup), computes dup share, score,
   stage, flags, priority. Writes `.vibe/state.json`, appends an event. `cmdScan` appends
   git time (`gitMs`) and full-cycle time (`totalMs`) to `state.scan`.

### Duplicate search

**Level 1 — exact clones** (`src/scanner.js`): `normalizeContent()` strips BOM, normalizes
line endings, blank lines, trailing spaces **and language comments**. Files differing only
in comments count as clones. `sha256` over normalized text; a group is a hash with ≥2 files.
Size filters: `dup.minSize` 128 B, `dup.maxSize` 256 KB, `dup.minLines` 5.

**Level 2 — near-clones** (`src/dup.js`): participants are dup-eligible files (same filters,
extensions from `DUP_EXTENSIONS`) not in exact groups. Signature: shingle = 5 words, minhash
n=48. Candidates via LSH: signature cut into 16 bands of 3 rows; a whole band matches → a
candidate pair (buckets >12 files are treated as template noise and skipped). Similarity ≥
`dup.nearThreshold` (0.85) → union-find → clusters = near-groups. Canon = member with the
highest summed similarity; `drift = 1 − similarity`. Limitation: minhash is an approximation.

**Combined list**: exact and near groups sorted together by weight `copies × lines × (near ?
similarity : 1)`. `crossProject` — files in different projects.

### Deletion candidates (`vibe cleanup`)

- Group canon is marked in `buildState`: two-pass assembly — first project scores without
  dups (breaks the "canon ← score ← dups" cycle), then `markCanonicalInGroup()`: canon =
  max score, tie → fresher. Members get `isCanonical`; group gets `wastedBytes`/`wastedLines`.
- `buildCleanupReport(state, {kind, minBytes})` aggregates: total, per-project breakdown,
  "entirely non-unique" projects (no canon in their groups) and near-dup weight separately.
  Default `kind: 'exact'` — near copies must not be deleted.
- The panel never deletes: the command and reports only show decisions.

### Incremental recompute (`vibe refresh`, `vibe watch`, `vibe serve --watch`)

- `collectProjectMetrics(path, cfg)` — full recompute of one project: nested roots re-found,
  metrics, markers, stack, hash Map and dup file list.
- `refreshProjectState(state, path, cfg)` — recomputes project, git, clone groups,
  `dupLines/dupShare/score/stage/flags/priority`, updates `generatedAt`.
- **Near-groups from signature cache** (`rebuildNearGroupsFromCache`): full scan saves minhash
  signatures of all near-candidates in `.vibe/signatures.json`. Refresh takes others' signatures
  from cache, rebuilds the current project's, and re-runs the shared LSH — near-groups rebuild
  in ~0.4 s without reading others' files.
- `watchProjects()` — `fs.watch` recursive over roots **plus `cheapMtime` poll every 5 s**
  (root + `.git/index`), ignores service dirs, finds project by longest prefix, debounce 1.2 s.
  `vibe watch` and `vibe serve --watch` write `state.json` after each recompute — the dashboard
  picks it up via SSE.

### Write-under-lease detector

Two sources, because the filesystem **does not report who changed a file**:

| Source | Knows | Event |
|---|---|---|
| `handlePreToolUse` (`src/write-hook.js`) | writer (`VIBE_AGENT`) and holder | `lease.violation`, `confirmed: true` |
| `watchProjects` (`src/watch.js`) | holder only | `lease.violation`, `confirmed: false` |

The hook is the precise channel; the watch is a fallback for hook-less agents. Disabled with
`leases.detectWrites: false`; dedup `leases.violationCooldownMs` (60 s per project+path).

### Web dashboard (`vibe serve`)

```
GET  /                → web/index.html
GET  /reports/<file>  → report from reports/ (name via path.basename, dir traversal closed)
GET  /api/state       → buildView(loadState()) + leases + conflictsCount + readLog()
GET  /api/config      → config (merged with defaults) + panelRoot + scan status
POST /api/config      → validating patch (sanitizeConfigPatch) → saveConfig → event
GET  /api/scan        → { running, startedAt, error }
POST /api/scan        → runScan on server (409 if already running); progress → SSE feed
GET  /api/cleanup     → buildCleanupView(): ?kind=exact|near, ?minBytes=N
POST /api/report      → writeReports() → { mdPath, htmlPath, mdUrl, htmlUrl }
GET  /api/brief       → buildBriefText(): markdown summary for a new agent session
GET  /api/events      → SSE: hello → log/refresh (fs.watch on state.json and leases.json)
прочее                → 404
```

In **demo mode** (`vibe demo` / `serve({ demo: true })`) the server loads `examples/demo-state.json`
instead of `.vibe/state.json`; `POST /api/config` and `POST /api/report` return 403, `POST /api/scan`
simulates completion (202), `GET /api/open` is disabled, no `fs.watch` runs.

### Scoring model (`src/score.js`)

Score 0–100 = sum of seven components. Each component's maximum is set by a **weight**
(default sum = 100); weights are configurable via `config.score.weights`.

| Component | Weight (default) | From |
|---|---:|---|
| `idea` — concept | 10 | README (6) + spec/docs (4) |
| `scaffold` — scaffold | 20 | manifest or stack (8) + lockfile (5) + has code (7) |
| `core` — core | 22 | `0.5·min(1, codeFiles/40) + 0.5·min(1, loc/5000)` |
| `tests` — tests | 20 | has tests (8) + framework in stack (4) + ≥3 test files (3) |
| `config` — configuration | 10 | `.env.example` (4) + config (3) + `.gitignore` (3) |
| `deploy` — run | 8 | Docker (4) + CI (3) + run script (3) |
| `docs` — documentation | 10 | README (5) + AGENTS.md/CLAUDE.md (5) |

**Penalties:** staleness >180 d −25, >120 d −20, >60 d −15; dup share >20% −10; no git −5.
Result clamped to 0–100. **Stages:** S0 Idea (<20), S1 Scaffold (<40), S2 Alpha (<60),
S3 Beta (<80), S4 Ready (<95), S5 Prod (≥95). **Flags:** `stale`, `nogit`, `noremote`,
`dirty`, `noreadme`, `notests`, `dups`, `orphan`.

### Data formats (see Russian section above for full schemas)

`.vibe/config.json`, `.vibe/state.json` (schema 3), `.vibe/events.jsonl`,
`.vibe/signatures.json`, `.vibe/leases.json`, `.vibe/conflicts.jsonl`,
`.vibe/handoffs.jsonl`. Handoff storage is append-only, keyed by `projectId` →
`projectPath` → `projectName`; `owner` is required.

### `/api/state` contract (view-model)

The frontend receives `buildView()` output, not `state.json`: `scannedAt`,
`summary{ total, withGit, withTests, stale60, dupWastedBytes, nearWastedBytes }`,
`dupKinds{ all, exact, near }`, `projects[]{…}`, `dupGroups[]{…}`, `projectDupGroups[]{…}`,
`leases[]{…}`, `conflictsCount`, `log[]{…}`.

### File leases (M3)

Advisory locks à la Beads. Voluntary: an agent takes a lease before editing (rules generated
by `vibe agents-md`); the panel blocks nothing at the FS level — the guarantee is that the
next `lease` on a busy file is rejected. Key = project + relative path (`.` = whole project).
TTL `leases.ttlMinutes` (30); expired leases are not returned and are dropped on next take.

### Agent rules (`vibe agents-md` → `writeAgentRules`)

Writes a rule block between markers `vibe:leases:start` / `vibe:leases:end`. Re-runs replace
the block, not append. Three files from one source: `AGENTS.md` (truth, full block + CLI path),
`CLAUDE.md` (`@AGENTS.md` shim, Claude Code), `GEMINI.md` (`@AGENTS.md` shim, Gemini CLI).
Symlinks don't work on Windows without admin; `--no-shim` / `--no-gemini` disable a shim.

### Mass rollout (`vibe agents-md --active`)

One command writes rules into all suitable working projects. Selection (`pickRolloutTargets`)
excludes: the scan root (it's a container); backups/copies/junk by name and path; stale
(> `maxIdleDays`, 14 d); **clones** by `foreignDupShare` (share of lines whose canon is
*another* project), threshold `maxForeignDup` = 0.9; nested projects (agents walk `AGENTS.md`
up the tree). Keys: `--active`, `--dry-run`, `--max-idle N`.

## MCP server (M4)

`src/mcp.js` + `bin/vibe-mcp.js` — stdio JSON-RPC 2.0, **zero dependencies**, newline-delimited.
The panel as a tool for any MCP client (code-agent). **Why not HTTP routes:** an agent raises
project context in one tool call instead of guessing which files to touch. All state is read
from disk — `vibe serve` is not needed. Transport: stdout is protocol only; logs go to stderr.
Tool: `vibe_status`, `vibe_projects`, `vibe_project`, `vibe_leases`, `vibe_lease_take`,
`vibe_lease_release`, `vibe_dups`, `vibe_cleanup`, `vibe_brief`, `vibe_refresh`,
`vibe_handoff_write`, `vibe_handoff_read` (12 total, version `0.5.0`).

## Boundaries

- **Windows-only in practice.** No tmux; activity from mtime and commits. Cyrillic paths work
  (`git -c core.quotepath=false`). `fs.watch` recursive — Windows/macOS; on Linux only top level.
- **Full cycle ~12 s** on ~50 projects / ~5 800 dirs (scan ~7 s + near-dup ~4.5 s + git ~1 s).
- **No SQLite.** The JSON file is fully rewritten. At typical volume (~50 projects, ~0.5 MB) it
  is faster and simpler; a move to SQLite WAL is planned.
- **minhash is an approximation**: a near-group with sim=1 does not guarantee text identity.
