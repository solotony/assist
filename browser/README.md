# Firefox Bridge

Управление настоящим Firefox из терминала: расширение + локальный мост.

```
CLI (node cli.mjs)  →  http://127.0.0.1:8787  →  расширение  →  Firefox
```

- Сервер слушает только `127.0.0.1`, наружу не открыт.
- Расширение временно ставится через `web-ext` в отдельный профиль `.assist/firefox-profile`.
- Профиль сохраняется между запусками (`--keep-profile-changes`), поэтому логины и куки не теряются.

## Запуск

```bash
./scripts/ff.sh                         # обычный запуск (рекомендуется)
./scripts/ff.sh --args=--headless       # без окна, если нужно
```

Откроется Firefox с расширением. Мост стартует автоматически.
Для Avito лучше обычный (headed) режим: антибот пропускает живой браузер, а headless чаще блокирует.

## Команды

```bash
node browser/bridge/cli.mjs open "https://www.avito.ru/..."
node browser/bridge/cli.mjs text
node browser/bridge/cli.mjs text "h1"
node browser/bridge/cli.mjs links
node browser/bridge/cli.mjs click "button[type=submit]"
node browser/bridge/cli.mjs type "input[name=q]" "нож ссср"
node browser/bridge/cli.mjs wait "[data-marker=item]"
node browser/bridge/cli.mjs eval "document.title"
node browser/bridge/cli.mjs screenshot
node browser/bridge/cli.mjs tabs
node browser/bridge/cli.mjs stop
```

Флаги: `--tab <id>`, `--timeout <ms>`, `--background`, `--json`.

`text`, `html`, `links` работают с активной вкладкой, если не указан `--tab`.
`eval` выполняется в изолированном мире расширения: DOM доступен, переменные страницы — нет.

## Пример: Avito

```bash
node browser/bridge/cli.mjs open "https://www.avito.ru/all?cd=1&q=%D0%BD%D0%BE%D0%B6+%D1%81%D1%81%D1%81%D1%80&s=104"
node browser/bridge/cli.mjs wait "[data-marker=item]"
node browser/bridge/cli.mjs text
node browser/bridge/cli.mjs screenshot
```

Если Avito показывает капчу — открой окно Firefox, пройди её один раз, профиль запомнит куки.

## Мониторинг объявлений Avito

```bash
./scripts/avito-watch.sh start          # каждые 5 минут
./scripts/avito-watch.sh start --interval 600
./scripts/avito-watch.sh status
./scripts/avito-watch.sh log
./scripts/avito-watch.sh stop
./scripts/avito-watch.sh once           # одна проверка вручную
```

Первый запуск сохраняет текущую выдачу как baseline и не присылает уведомления.
Дальше каждое новое объявление:

- сохраняется отдельным файлом `data/avito/listings/<дата>/<id>.md`;
- пишется строкой в `data/avito/new.log`;
- показывается macOS-уведомлением;
- коммитится и пушится в git.

Остальные файлы: `data/avito/state.json` (уже виденные ID), `data/avito/latest.json`
(последняя выдача целиком). URL и интервал меняются флагами `--url` и `--interval`.

Слежение идёт по первой странице выдачи, отсортированной по дате. Вкладку лучше
не закрывать и не переключать на другой сайт: watcher сам возвращает её на нужный URL.

## Остановка

Закрой Firefox или нажми Ctrl+C в терминале, где запущен `ff.sh`. Мост остановится командой:

```bash
node browser/bridge/cli.mjs stop
```

## Диагностика

```bash
curl -s http://127.0.0.1:8787/health | python3 -m json.tool
tail -f .assist/bridge.log
```
