#!/usr/bin/env bash
# Собирает zip для раздачи и проверяет, что в нём есть все файлы,
# на которые ссылается manifest.json. Неполная папка — самая частая
# причина ошибки «Не удалось загрузить JavaScript … для скрипта содержимого»:
# браузер отказывается ставить расширение целиком, если не хватает одного файла.
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')
OUT="dist/vk7tv-${VERSION}.zip"

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
rm -f "$OUT"
# в архив идёт только то, что под гитом, — без .idea, .DS_Store и dist;
# служебные файлы сборки пользователю не нужны
git ls-files -z | grep -zv -e '^build\.sh$' -e '^\.gitignore$' | xargs -0 zip -q -X "$OUT"

# контрольная проверка: файлы манифеста действительно внутри архива
while IFS= read -r f; do
  [ -n "$f" ] || continue
  unzip -l "$OUT" "$f" >/dev/null 2>&1 || { echo "В архиве нет $f" >&2; exit 1; }
done <<< "$REQUIRED"

echo "Готово: $OUT"
unzip -Z1 "$OUT" | sed 's/^/  /'
