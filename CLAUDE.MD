# CLAUDE.md

Этот файл — инструкция для Claude Code (claude.ai/code) при работе с кодом в этом репозитории.

## Обзор проекта

TenderHUB by SU_10 — портал управления тендерами в строительстве для BOQ (Bill of Quantities, ведомости объёмов работ) и биржевых процессов.

- **Языковые конвенции**: русский UI, английский код, русские сообщения коммитов
- **Стек**: React 18 + Ant Design + Vite + TypeScript на фронте. Go BFF (chi + pgx/v5 + coder/websocket) перед Supabase (Postgres 17 + Auth + JWKS). Supabase Realtime постепенно вытесняется WebSocket-хабом Go BFF.
- **Брендинг**: дизайн-система описана в BRANDING.md
- **Состояние миграции**: pre-prod Supabase-проект `ocauafggjrqvopxjihas`; старый live-prod `wkywhjljrhewfpedbjzx` в режиме read-only до финального cutover. Полный план — в `C:\Users\Usrr\.claude\plans\keen-toasting-iverson.md`.

## Команды разработки

```bash
npm install          # установить зависимости
npm run dev          # dev-сервер (http://localhost:5185, автоматически откроется)
npm run build        # TypeScript-проверка + production-сборка Vite
npm run lint         # ESLint в режиме zero-warning (max-warnings: 0)
npm run preview      # превью production-сборки
npm run gen:types    # перегенерировать src/lib/supabase/database.types.ts из pre-prod
npm run gen:schema   # обновить supabase/schemas/prod.sql

## Критические правила

### Секреты не должны начинаться с VITE_
Vite инлайнит каждую `VITE_*`-переменную в клиентский бандл. НИКОГДА не добавляй префикс `VITE_` к секрету:
- ✅ `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (anon-ключ публичен по дизайну)
- ❌ `VITE_SUPABASE_SERVICE_ROLE_KEY`, `VITE_DATABASE_URL`, любой JWT-ключ подписи, пароль БД
- Серверные переменные (dev-скрипты в `scripts/`, Go-бэкенд) используют обычные имена: `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` и т.д.
- Шаблон — в `.env.example`.

### Лимит на размер файла
**СТРОГО**: все файлы должны быть ≤ 600 строк. Разбивай на `components/`, `hooks/`, `utils/`, `types.ts` по необходимости.

### Git-конвенции
- **Коммиты**: русский, повелительное наклонение (например, «Добавить валидацию форм», «Исправить ошибку в расчётах»)
- **Ветки**: префиксы `feature/`, `fix/`, `refactor/`

## Архитектура

## Технологический стек


## Адаптивность (обязательно)

Все UI компоненты адаптированы под:
- **iPhone 15 Pro Max** (430 × 932 px)
- **iPhone 12** (390 × 844 px)
- **iPad** (768 × 1024 px и больше)

CSS media queries для всех целевых устройств.

## КРАТКОСТЬ

- Отвечай максимально сжато. Без пояснений и предисловий.
- Код — только рабочие фрагменты в блоках, без текста.
- Изменения — *минимальный diff/patch* или *конкретные вставки*.
- Не перечисляй «что было сделано», если не попросили.
- Текст — не более 5 пунктов, каждый ≤ 12 слов.

## .env

- НИКОГДА не изменять `.env` файлы
- Ключи и URL добавляет только пользователь вручную

## Git

- Коммиты на русском, кратко (1-2 предложения)
- Без приписок "Generated with Claude Code" и "Co-Authored-By"
