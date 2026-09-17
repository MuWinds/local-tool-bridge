import io

TARGET = r"C:\Users\MuWinds\Documents\Coding Project\local-tool-bridge\apps\extension\src\content\scrubber.ts"
SNIPPET = r"C:\Users\MuWinds\Documents\Coding Project\local-tool-bridge\scripts\dlb-style-css.txt"

new = io.open(SNIPPET, encoding="utf-8").read().rstrip("\n")
src = io.open(TARGET, encoding="utf-8").read()

start = src.index("const STYLE_CSS = `")
end = src.index("\n`;", start) + len("\n`;")

io.open(TARGET, "w", encoding="utf-8", newline="\n").write(src[:start] + new + src[end:])
print("restyled ok")
