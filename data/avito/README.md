# Avito listings

Данные мониторинга поиска «нож ссср»:
`https://www.avito.ru/all?cd=1&q=нож+ссср&s=104` (сортировка по дате).

- `listings/<YYYY-MM-DD>/<id>.md` — по одному файлу на объявление.
- `new.log` — машиночитаемый журнал новых объявлений (TSV).
- `state.json` — ID уже виденных объявлений и состояние вкладки (локальный кеш, не в git).
- `latest.json` — последняя выдача целиком (локальный кеш, не в git).

Управление: `./scripts/avito-watch.sh {start|stop|status|once|log}`.
