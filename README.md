# vibe-cockpit

[![CI](https://github.com/DelionR/vibe-cockpit/actions/workflows/ci.yml/badge.svg)](https://github.com/DelionR/vibe-cockpit/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Панель управления вайбкодингом** — единый агрегатор состояния всех проектов
и заготовок одного разработчика. Решает четыре проблемы: централизованный статус,
выявление дубликатов и конфликтующих версий, передача контекста между агентами
и визуализация состояния портфеля.

**Ноль зависимостей** — только Node 22 stdlib. Без сборки, без npm-пакетов.

---

## Возможности

- **Инвентаризация** проектов: стек, язык, наличие git/тестов, объём кода.
- **Readiness-скор 0–100** и стадии `S0 Идея → S5 Прод` — по каким проектам
  пора что-то делать, а какие готовы.
- **Детектор дублей** двух уровней: точные клоны (уровень 1) и почти-клоны
  по minhash-подписям (уровень 2). Показывает, сколько места можно освободить.
- **Аренды файлов** с TTL — чтобы два агента не перетирали один файл.
- **Handoff-пакеты** — передача контекста следующему агенту без копирования сводок.
- **Живой дашборд** (`vibe serve` + SSE): карточки, фильтры, лента событий.
- **MCP-сервер** (12 инструментов) — любой код-агент достаёт данные панели
  вызовами инструментов, без запущенного дашборда.
- **Демо-режим** (`bin/vibe-demo.js`) — дашборд на вымышленных данных. Изолированный модуль (`src/demo/`), не влияет на production-код.
  Идеален для знакомства и скриншотов.

## Быстрый старт

Требуется **Node 22+**.

```bash
# Клонировать и запустить демо (вымышленные данные, ничего не сканируется)
git clone https://github.com/DelionR/vibe-cockpit.git
cd vibe-cockpit
node bin/vibe-demo.js
# открой http://127.0.0.1:5173
```

Демо загружает `examples/demo-state.json` (8 синтетических проектов, включая
трёх-way кластер клонов - одного проекта и показывает все сценарии дашборда. Это
полностью отдельная точка входа: она импортирует только `src/demo/index.js`
и не трогает конфиг/состояние реальной панели.

### Реальное использование

```bash
node bin/vibe.js init --root "<ВАШИ_ПРОЕКТЫ>"   # один раз: создать конфиг
node bin/vibe.js scan                           # пересобрать состояние (~12 с)
node bin/vibe.js stats                          # сводка по стадиям
node bin/vibe.js list                           # что требует решения прямо сейчас
node bin/vibe.js dup --kind near                # скопированные между проектами файлы
node bin/vibe.js serve                           # живой дашборд: http://localhost:5173
```

Полный список команд — в `docs/USAGE.md`. Устройство панели — в `docs/ARCHITECTURE.md`.

## Пример вывода

```
Состояние на 06.09.2026 · проектов 8 · с git 4 · с тестами 5 · застой >60д 0
Дублей: 2 групп (точных 2, похожих 0) · можно освободить 1.2 КБ
```

(Цифры выше — из демо-набора. Ваши будут своими.)

## Почему это работает

- **Статус выводится из диска, а не вводится руками.** Ручной ввод протухает;
  панель пересчитывает всё при скане.
- **Фронтенд не знает внутренней схемы.** Адаптация `state.json` → view-модель
  происходит в `buildView()` (`src/serve.js`).
- **Append-only журнал событий** — `.vibe/events.jsonl` только дописывается;
  состояние `.vibe/state.json` перезаписывается при каждом скане.

## Структура

| Путь | Назначение |
|---|---|
| `bin/vibe.js` | точка входа CLI |
| `src/` | каноническая реализация (Node 22 stdlib, ноль зависимостей) |
| `web/index.html` | дашборд (ванильный JS, без сборки) |
| `tools/smoke.mjs` | регрессионный тест (227 проверок) |
| `examples/` | демо-данные и шаблоны инструкций агентов |
| `docs/USAGE.md` | как эффективно использовать |
| `docs/ARCHITECTURE.md` | устройство, схема данных, контракт API |

## Тесты

```bash
node tools/smoke.mjs   # 227 проверок: CLI, скан, дубли, аренды, MCP, демо-режим
```

В CI этот же прогон запускается на Node 22 при каждом пуше (`.github/workflows/ci.yml`).

## Лицензия

MIT — см. `LICENSE`.

---

# vibe-cockpit (English)

[![CI](https://github.com/DelionR/vibe-cockpit/actions/workflows/ci.yml/badge.svg)](https://github.com/DelionR/vibe-cockpit/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Vibecoding control panel** — a single dashboard for the state of all your
projects and coding experiments. It solves four problems: a centralized status
view, duplicate / conflicting-version detection, context hand-off between AI
agents, and portfolio visualization.

**Zero dependencies** — Node 22 stdlib only. No build step, no npm packages.

## Features

- **Inventory** of projects: stack, language, git/tests presence, code volume.
- **Readiness score 0–100** and stages `S0 Idea → S5 Prod` — know which projects
  need attention and which are shippable.
- **Duplicate detector**, two levels: exact clones (level 1) and near-clones via
  minhash signatures (level 2). Shows how much space you can reclaim.
- **File leases** with TTL — so two agents never overwrite the same file.
- **Handoff packages** — pass context to the next agent without copying summaries.
- **Live dashboard** (`vibe serve` + SSE): cards, filters, event stream.
- **MCP server** (12 tools) — any code-agent pulls panel data via tool calls,
  no running dashboard required.
- **Demo mode** (`bin/vibe-demo.js`) — dashboard on fictional data, no access to your
  files. An isolated module (`src/demo/`) that never touches production code.
  Perfect for a first look and screenshots.

## Quick start

Requires **Node 22+**.

```bash
git clone https://github.com/DelionR/vibe-cockpit.git
cd vibe-cockpit
node bin/vibe-demo.js
# open http://127.0.0.1:5173
```

The demo loads `examples/demo-state.json` (8 synthetic projects, including a
three-way `salebot-*` clone cluster) and exercises every dashboard scenario.
It is a fully separate entry point that imports only `src/demo/index.js` and
never touches the real panel's config or state.

### Real usage

```bash
node bin/vibe.js init --root "<YOUR_PROJECTS>"   # once: create config
node bin/vibe.js scan                            # rebuild state (~12 s)
node bin/vibe.js stats                           # stage summary
node bin/vibe.js list                            # what needs a decision now
node bin/vibe.js dup --kind near                 # files copied across projects
node bin/vibe.js serve                           # live dashboard at localhost:5173
```

Full command list in `docs/USAGE.md`. Internals in `docs/ARCHITECTURE.md`.

## Why it works

- **Status is derived from disk, never typed by hand.** Manual input goes stale;
  the panel recomputes everything on scan.
- **The frontend knows nothing about the internal schema.** Adapting
  `state.json` → view-model happens in `buildView()` (`src/serve.js`).
- **Append-only event log** — `.vibe/events.jsonl` is only appended;
  `.vibe/state.json` is fully rewritten on each scan.

## Layout

| Path | Purpose |
|---|---|
| `bin/vibe.js` | CLI entry point |
| `src/` | canonical implementation (Node 22 stdlib, zero deps) |
| `web/index.html` | dashboard (vanilla JS, no build) |
| `tools/smoke.mjs` | regression test (227 checks) |
| `examples/` | demo data and agent-instruction templates |
| `docs/USAGE.md` | how to use it effectively |
| `docs/ARCHITECTURE.md` | design, data schema, API contract |

## Tests

```bash
node tools/smoke.mjs   # 227 checks: CLI, scan, dups, leases, MCP, demo mode
```

The same run executes in CI on Node 22 on every push (`.github/workflows/ci.yml`).

## License

MIT — see `LICENSE`.
