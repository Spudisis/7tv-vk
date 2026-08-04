#!/usr/bin/env bash
# Собирает zip для раздачи и проверяет, что в нём есть все файлы,
# на которые ссылается manifest.json. Неполная папка — самая частая
# причина ошибки «Не удалось загрузить JavaScript … для скрипта содержимого»:
# браузер отказывается ставить расширение целиком, если не хватает одного файла.
set -euo pipefail
cd "$(dirname "$0")"

# --store — дополнительно собрать «плоский» zip с manifest.json в корне:
# именно такой ждёт Chrome Web Store. Обычный архив кладёт всё в папку
# vk7tv/ (это нужно для ручной установки — ID расширения там считается
# от пути к папке), а стору папка-обёртка не годится.
STORE=0
[ "${1:-}" = "--store" ] && STORE=1

VERSION=$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')
OUT="dist/vk7tv-${VERSION}.zip"
STAGE="dist/vk7tv"

# все пути, которые манифест обязывает иметь на диске
REQUIRED=$(python3 - <<'PY'
import json
m = json.load(open("manifest.json"))
files = ["manifest.json"]
for cs in m.get("content_scripts", []):
    files += cs.get("js", []) + cs.get("css", [])
sw = m.get("background", {}).get("service_worker")
if sw:
    files.append(sw)
popup = m.get("action", {}).get("default_popup")
if popup:
    files.append(popup)
files += list(m.get("icons", {}).values())
print("\n".join(dict.fromkeys(files)))
PY
)

missing=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if [ ! -f "$f" ]; then
    echo "НЕТ ФАЙЛА: $f (на него ссылается manifest.json)" >&2
    missing=1
  fi
done <<< "$REQUIRED"
[ "$missing" -eq 0 ] || { echo "Сборка отменена: папка неполная." >&2; exit 1; }

mkdir -p dist
rm -rf "$OUT" "$STAGE"
mkdir -p "$STAGE"
# Внутри архива всё лежит в папке vk7tv — имя не зависит от версии.
# Это важно: у распакованного расширения ID считается от пути к папке,
# поэтому «vk7tv-0.8.1» рядом со старой папкой браузер посчитал бы другим
# расширением и завёл бы ему пустое хранилище — наборы «пропали бы».
# в архив идёт только то, что под гитом, — без .idea, .DS_Store и dist;
# служебные файлы сборки, картинки для README, модуль для Android и папку
# .claude (внутренние скиллы) расширению не нужны — у модуля своя сборка
# в android/, а .claude в публичном расширении лежать не должна
git ls-files -z | grep -zv -e '^build\.sh$' -e '^\.gitignore$' -e '^\.claude/' -e '^docs/' -e '^android/' | while IFS= read -r -d '' f; do
  mkdir -p "$STAGE/$(dirname "$f")"
  cp "$f" "$STAGE/$f"
done
(cd dist && zip -qXr "vk7tv-${VERSION}.zip" vk7tv)

# контрольная проверка: файлы манифеста действительно внутри архива
while IFS= read -r f; do
  [ -n "$f" ] || continue
  unzip -l "$OUT" "vk7tv/$f" >/dev/null 2>&1 || { echo "В архиве нет $f" >&2; exit 1; }
done <<< "$REQUIRED"

echo "Готово: $OUT"
unzip -Z1 "$OUT" | sed 's/^/  /'

# Плоский архив для Chrome Web Store: те же файлы, но в корне zip.
if [ "$STORE" -eq 1 ]; then
  STORE_OUT="dist/vk7tv-${VERSION}-store.zip"
  rm -f "$STORE_OUT"
  (cd "$STAGE" && zip -qXr "../vk7tv-${VERSION}-store.zip" .)
  unzip -l "$STORE_OUT" manifest.json >/dev/null 2>&1 || {
    echo "В store-архиве manifest.json не в корне" >&2; exit 1; }
  echo "Для стора: $STORE_OUT"
  unzip -Z1 "$STORE_OUT" | sed 's/^/  /'
fi
