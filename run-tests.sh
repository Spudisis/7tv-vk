#!/usr/bin/env bash
# Прогон стендов из tests/ в headless Chrome.
#
# Стенды подключают настоящие скрипты расширения к странице с заглушкой
# chrome.* (tests/harness.js) и проверяют поведение так, как его видит
# пользователь: что оказалось в сетке, какого размера ячейки, что стоит
# в сообщении. Отчёт стенд печатает в #result, здесь он разбирается.
#
# Страницы отдаются по http, а не открываются файлом: у file:// свой origin,
# и window.onerror приходит без текста ошибки («Script error.») — упавший
# стенд было бы не разобрать.
set -euo pipefail
cd "$(dirname "$0")"

CHROME="${CHROME:-}"
if [ -z "$CHROME" ]; then
  for c in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$(command -v google-chrome || true)" \
    "$(command -v google-chrome-stable || true)" \
    "$(command -v chromium || true)" \
    "$(command -v chromium-browser || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && CHROME="$c" && break
  done
fi
[ -n "$CHROME" ] || { echo "Не нашёл Chrome. Укажи путь: CHROME=... ./run-tests.sh" >&2; exit 1; }

export CHROME
node tests/run.mjs "$@"
