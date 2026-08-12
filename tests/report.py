# Разбор отчёта стенда: на вход — строка RESULT {...} из --dump-dom,
# на выход — читаемые строки и код возврата. Отдельным файлом, чтобы
# не прятать python внутри кавычек в run-tests.sh.
import html
import json
import sys

raw = sys.stdin.read().strip()
if not raw:
    print("пустой отчёт")
    sys.exit(1)

r = json.loads(html.unescape(raw))
failed = r["failed"]
mark = "OK  " if not failed else "FAIL"
print("%s %s — проверок %d, провалов %d" % (mark, r["page"], r["total"], failed))
# при провале печатаем весь список: по соседним строкам видно, на чём отвалилось
for line in r["lines"]:
    if failed or "-v" in sys.argv:
        print(line)
sys.exit(1 if failed else 0)
