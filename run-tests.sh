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

PORT="${PORT:-8731}"
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
# ждём, пока сервер начнёт отвечать: без этого первый стенд иногда получал отказ
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$PORT/manifest.json" >/dev/null && break
  sleep 0.1
done

dump() {
  "$CHROME" --headless --disable-gpu --no-sandbox --virtual-time-budget=15000 \
    --dump-dom "http://127.0.0.1:$PORT/$1" 2>/dev/null || true
}

extract() {
  printf '%s' "$1" | grep -o 'RESULT {.*}' | head -1 | sed 's/^RESULT //' || true
}

fail=0
for page in tests/*.test.html; do
  dom=$(dump "$page")
  report=$(extract "$dom")
  # Chrome иногда не отдаёт разметку, если прошлый его процесс ещё
  # закрывается: один повтор дешевле шаткого прогона.
  if [ -z "$report" ]; then
    sleep 2
    dom=$(dump "$page")
    report=$(extract "$dom")
  fi
  if [ -z "$report" ]; then
    echo "FAIL $page — стенд не дошёл до отчёта (страница упала или зависла)"
    [ "${1:-}" = "-v" ] && printf '%s\n' "$dom" | tail -5
    fail=1
    continue
  fi
  printf '%s' "$report" | python3 tests/report.py "$@" || fail=1
done

[ "$fail" -eq 0 ] && echo "Все стенды прошли." || echo "Есть провалы." >&2
exit "$fail"
