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

VERSION=$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])' | tr -d '\r')
OUT="dist/vk7tv-${VERSION}.zip"
STAGE="dist/vk7tv"

# все пути, которые манифест обязывает иметь на диске
REQUIRED=$(python3 - <<'PY' | tr -d '\r'
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
for war in m.get("web_accessible_resources", []):
    files += war.get("resources", [])
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
# zip/unzip есть не везде (например, в Git Bash на Windows), а Python уже
# нужен выше. Собираем и проверяем архив им, чтобы build.sh не зависел от
# внешнего zip.
pack_zip() { # каталог, архив, префикс внутри архива
  python3 - "$1" "$2" "$3" <<'PY'
import os, sys, zipfile
stage, out, prefix = sys.argv[1:4]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _dirs, files in os.walk(stage):
        for name in files:
            full = os.path.join(root, name)
            rel = os.path.relpath(full, stage).replace(os.sep, "/")
            z.write(full, (prefix + "/" + rel) if prefix else rel)
PY
}

has_zip_entry() { # архив, путь
  python3 - "$1" "$2" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    sys.exit(0 if sys.argv[2] in z.namelist() else 1)
PY
}

list_zip() {
  python3 - "$1" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    for name in z.namelist():
        print("  " + name)
PY
}

# Внутри архива всё лежит в папке vk7tv — имя не зависит от версии.
# Это важно: у распакованного расширения ID считается от пути к папке,
# поэтому «vk7tv-0.8.1» рядом со старой папкой браузер посчитал бы другим
# расширением и завёл бы ему пустое хранилище — наборы «пропали бы».
# в архив идёт только то, что под гитом, — без .idea, .DS_Store и dist;
# служебные файлы сборки, картинки для README, модуль для Android и папку
# .claude (внутренние скиллы) расширению не нужны — у модуля своя сборка
# в android/, а .claude в публичном расширении лежать не должна
git ls-files -z | grep -zv -e '^build\.sh$' -e '^run-tests\.sh$' -e '^\.gitignore$' \
  -e '^\.claude/' -e '^\.github/' -e '^docs/' -e '^android/' -e '^tests/' |
  while IFS= read -r -d '' f; do
  mkdir -p "$STAGE/$(dirname "$f")"
  cp "$f" "$STAGE/$f"
done
pack_zip "$STAGE" "$OUT" vk7tv

# контрольная проверка: файлы манифеста действительно внутри архива
while IFS= read -r f; do
  [ -n "$f" ] || continue
  has_zip_entry "$OUT" "vk7tv/$f" || { echo "В архиве нет $f" >&2; exit 1; }
done <<< "$REQUIRED"

echo "Готово: $OUT"
list_zip "$OUT"

# Плоский архив для Chrome Web Store: те же файлы, но в корне zip.
if [ "$STORE" -eq 1 ]; then
  STORE_OUT="dist/vk7tv-${VERSION}-store.zip"
  rm -f "$STORE_OUT"
  pack_zip "$STAGE" "$STORE_OUT" ''
  has_zip_entry "$STORE_OUT" manifest.json || {
    echo "В store-архиве manifest.json не в корне" >&2; exit 1; }
  echo "Для стора: $STORE_OUT"
  list_zip "$STORE_OUT"
fi
