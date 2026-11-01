import io
import re

root = r"C:\Users\justin\Desktop\opensource-everything\sketchup\apps\app"
main = io.open(root + r"\src\main.ts", encoding="utf-8", newline="").read()
html = io.open(root + r"\index.html", encoding="utf-8", newline="").read()

in_html = set(re.findall(r'\bid="([^"]+)"', html))
used = set(re.findall(r'\$\("([^"]+)"\)', main))
# Ids created in JS rather than declared in the HTML.
created = set(re.findall(r'\.id = "([^"]+)"', main))

print("html:", len(in_html), "js-created:", sorted(created))
missing = sorted(used - in_html - created)
print("missing from index.html:", missing if missing else "none")
unused = sorted(in_html - used - created)
print("in html but never reached by main.ts:", unused if unused else "none")
