# chat.deepseek.com DOM hooks — sourced report

**Method note:** `web_fetch` was blocked for `github.com` / `greasyfork.org` / `raw.githubusercontent.com`
("resolves to a non-public IP address") in this sandbox. All fetching was done with `curl` via the shell.
No login was attempted anywhere.

**Primary source (strongest evidence):** DeepSeek's own production bundles, served publicly, no auth:

| Asset | Size | Last-Modified |
|---|---|---|
| `https://fe-static.deepseek.com/chat/static/main.3208e09460.css` | 288,474 B | 2026-09-14 |
| `https://fe-static.deepseek.com/chat/static/main.9199a2404f.js` | 1,500,661 B | 2026-09-15 |

Fetched 2026-09-16 (UTC). Discovered from `https://chat.deepseek.com/` HTML.
**Caveat: I never saw a live authenticated transcript.** The chat UI needs a session to render messages,
so everything below is static-bundle + third-party-script evidence, not observed DOM.

---

## 1. User message bubbles

**Container: `.fbb737a4`** — a CSS-module hash, not semantic.

- JS (module `27161`, export `Rq`): `e.exports={...,Rq:"fbb737a4",vN:"_8271fc3",...}`
- JSX: `(0,S.jsxs)("div",{className:(0,tb.A)(v$.Rq,g&&v$.vN),ref:_,children:[(0,S.jsx)(gC,{content:l,bubbleElRef:_,...})]})`
- CSS: `.fbb737a4{max-width:calc(100% - 68px)}` and `.fbb737a4._8271fc3{margin-top:10px}`
  (the `100% - 68px` cap is what makes it read as a right-aligned bubble body)

Independent corroboration (two unrelated authors):
- 8Bit userstyle: `body[data-ds-dark-theme] .fbb737a4 { background: ...; }` and `.fbb737a4{max-height:240px;overflow-y:scroll}`
- greasyfork 592029: `userBubble: '.fbb737a4',   // 用户气泡正文容器`

**Nesting / inner content — only partly verified.** The bubble div wraps a `gC` content component.
I confirmed long user messages get a collapsible wrapper (`fbb737a4 .ds-collapsible-text-toggle-button`
is styled by script 592029), but I did **not** definitively confirm a `.ds-markdown` inside `.fbb737a4`.
Do not assume it.

**No stable hook exists on user messages.** Specifically:
- `data-message-author-role` — **0 occurrences** in the current JS bundle.
  [ArcRift's `PLATFORM_SELECTORS.md`](https://raw.githubusercontent.com/Eshaan-Nair/ArcRift/refs/tags/v1.5.1/PLATFORM_SELECTORS.md)
  claims `[data-message-author-role="user"]` works on DeepSeek and calls it "intentional". **That claim is
  unsubstantiated by the shipped code** and its own notes read as speculative. Treat as unreliable.
- `.user-message`, `[data-testid="user-message"]`, `[class*="UserMessage"]` — none present.
- The only `data-role` in the bundle is `data-role="measure"` on a **model-selector** element, unrelated.
- `.dd442025` — used by scripts 530564 and the 8Bit style as a second bubble class. **0 occurrences** in
  the current bundle. Already gone. Direct proof that these hashes churn.

---

## 2. Thinking / reasoning (深度思考) blocks

**Not** `<details>`/`<summary>`. It is a `div` with a clickable header that toggles state.

| Part | Selector | Evidence |
|---|---|---|
| Whole think block | `._74c0879` (+ `_281115f` modifier) | JS module `37951`: `{wM:"_74c0879",qA:"_281115f",...}`; CSS `._74c0879{position:relative}`, `._74c0879+.ds-assistant-message-main-content{margin-top:10px}` |
| Clickable header | `._5ab5d64` | CSS `. _5ab5d64{...flex-grow:1;...display:flex}` + `:hover{color:...}`; scripts 562097 (`toggleButton`) & 580006 (`STATUS_SEL='div._5ab5d64 > span'`) |
| Header wrapper | `._245c867` | script 580006 `HEADER_SEL='div._245c867'`; present in CSS |
| **Reasoning text** | **`.ds-think-content`** | JSX: `(0,S.jsxs)("div",{className:(0,tb.A)(px.GJ,"ds-think-content",s&&px.dq),...})` where `px.GJ="e1675d8b"` |
| Collapsed-state class | `e47135bc` | scripts 562097 & 580006 — **0 occurrences in current CSS *and* JS. Stale or runtime-only; do not rely on it.** |

**Reasoning text is markdown-rendered HTML, not plain text.** Proof: CSS contains
`.ds-think-content .ds-markdown{font:var(--dsw-font-markdown-small);color:var(--dsw-alias-label-secondary)}`
plus rules for `h1..h6`, `code`, `blockquote`, `hr` scoped under it. The JS renderer `pE` feeds the
reasoning string into the same markdown component `iw` used for assistant content
(`(0,S.jsx)(iw,{...content:u...})`, `u = fragment.useThinkFragment(r).content`).

### Two traps worth knowing before writing CSS

1. **`.ds-think-content` is conditionally rendered.** Collapsing *removes it from the DOM*; expanding
   re-inserts it. Script 592029 documents this from measurement:
   `实测：折叠 = 站点移除 .ds-think-content；展开 = 插回。`
   → Hiding `.ds-think-content` only hides **expanded** reasoning. The container `._74c0879` and its
   header stay visible. To hide the whole section you must target `._74c0879`.
2. Conversely, `.ds-think-content` is therefore **not** a reliable "does thinking exist" marker while collapsed.

---

## 3. Markdown content

**`.ds-markdown`** — semantic, `ds-` namespaced, **the best hook in this whole report.**

- JSX: `(0,S.jsx)("div",{className:(0,tb.A)("ds-markdown",l),children:(0,S.jsx)(is,{nodes:t.children})})`
- CSS: `.ds-markdown{font:var(--dsw-font-markdown-small);color:var(--dsw-alias-label-secondary)}`
- Also semantic and confirmed: `.ds-assistant-message-main-content` (assistant body),
  `.ds-markdown-paragraph`, `.ds-markdown-html`, `.ds-markdown-cite*`, `.ds-markdown-math*`,
  `.ds-markdown-task-checkbox`, `.ds-markdown-code-copy-button`.
- **Not** `ds-` prefixed but confirmed present: `.md-code-block`, `.md-code-block-banner*`, `.md-code-block-footer`.
- **No** `data-*` or `aria-*` attribute hooks on markdown content.
- `.ds-markdown--block` (used by the ds-mcp-bridge adapter) — **0 occurrences** in the current bundle. Stale.

---

## 4. CSS-module hash stability

Hashed (regex `^_?[0-9a-f]{7,8}$`) and **unreliable**: `.fbb737a4`, `._74c0879`, `._5ab5d64`, `._245c867`,
`._4f9bf79`, `._8271fc3`, `e1675d8b`, `_9b52f6c`, `_9ecc93a`, `_767406f`, `_965abe9`, `_448e4c0`, `_2109e59`.

**Observed churn (hard evidence, not speculation):** `.dd442025`, `e47135bc`, and `.ds-markdown--block` all
appear in third-party scripts but have **0 occurrences** in the current bundle. These hashes do change.

### Stable / non-hashed hooks found

- `.ds-markdown`, `.ds-think-content`, `.ds-assistant-message-main-content`, `.ds-theme`,
  `.ds-collapsible-text`, `.ds-collapsible-text-toggle-button`, `.md-code-block`
- `#chat-input` (the input is `<textarea id="chat-input">`)
- `body[data-ds-dark-theme]` (set in dark mode; `body.dark` / `body.light` classes also toggled)
- `data-virtual-list-item-key="<id>"` on each virtualized message row
- `data-conversation-search-result-index`, `data-model-type`, `data-keyboard-focused`

**Honest summary:** there is **no stable, semantic hook for the user message bubble.** `.fbb737a4` is a hash.
The thinking section's *content* has a stable semantic hook (`.ds-think-content`), but its *container* is a
hash (`._74c0879`) — and the container is what you need if you want to hide the header too.

---

## 5. Known userscripts / userstyles and their exact selectors

| Source | Exact selector(s) used |
|---|---|
| [greasyfork 576373 — 隐藏DeepSeek深度思考内容](https://greasyfork.org/ckb/scripts/576373-%E9%9A%90%E8%97%8Fdeepseek%E6%B7%B1%E5%BA%A6%E6%80%9D%E8%80%83%E5%86%85%E5%AE%B9/code) | `GM_addStyle('.ds-think-content { display: none !important; }')` — the entire script |
| [greasyfork 562097 — DeepSeek Think 自动收起 v2.5](https://greasyfork.org/fi/scripts/562097-deepseek-think-%E8%87%AA%E5%8A%A8%E6%94%B6%E8%B5%B7/code) | `thinkBlockContainer:'_74c0879'`, `collapsedStateClass:'e47135bc'`, `toggleButton:'_5ab5d64'`, `thinkContent:'ds-think-content'`. Its own header warns: "本脚本依赖 DeepSeek 网站的 CSS 类名，官网更新后可能失效" |
| [greasyfork 580006 — Deepseek默认折叠思考 v0.2.1](https://greasyfork.org/fi/scripts/580006-deepseek%E9%BB%98%E8%AE%A4%E6%8A%98%E5%8F%A0%E6%80%9D%E8%80%83/code) | `THINK_SEL='div._74c0879'`, `HEADER_SEL='div._245c867'`, `STATUS_SEL='div._5ab5d64 > span'`, `COLLAPSED_CLS='e47135bc'`; detects done-state via `span.textContent.includes('已思考')` |
| [greasyfork 592029 — DeepSeek 全功能增强](https://greasyfork.org/ko/scripts/592029-deepseek-%E5%85%A8%E5%8A%9F%E8%83%BD%E5%A2%9E%E5%BC%BA) | `userBubble:'.fbb737a4'`, `thinkBlock:'._74c0879'`, `thinkContent:'.ds-think-content'`; styles `.fbb737a4 .ds-collapsible-text-toggle-button`; documents the collapse-removes-DOM behavior |
| [greasyfork 530564 — DeepSeek Chat Tweaks Turbo](https://greasyfork.org/en/scripts/530564-deepseek-chat-tweaks-turbo-edition-with-hidden-pre-prompt/code) | `._77cefa5 .dd442025` (**stale class**) |
| [NullCipherr/DeepSeek-8Bit-UserStyle](https://github.com/NullCipherr/matugen-stylus) (`Deepseek/Deepseek-Matugen.css`) | `body[data-ds-dark-theme] .fbb737a4`, `body[data-ds-dark-theme] .dd442025`, `.ds-markdown`, `.fbb737a4{max-height:240px;overflow-y:scroll}` |
| [ArcRift PLATFORM_SELECTORS.md](https://raw.githubusercontent.com/Eshaan-Nair/ArcRift/refs/tags/v1.5.1/PLATFORM_SELECTORS.md) | Claims `[data-message-author-role="user"]`, `.user-message`, `[class*="UserMessage"]`; AI `[data-message-author-role="assistant"]`, `.ds-markdown`. Dated "May 2026, Stability: Medium". **The `data-message-author-role` part is not supported by the bundle — unreliable.** The `.ds-markdown` part is correct. |

No userscript was found that hides **user messages** specifically. Scripts target thinking blocks, or restyle
the bubble. `.fbb737a4` is the selector such a script would have to use.

---

## 6. What I could NOT verify

- **No live authenticated DOM.** Never logged in, per instructions; the transcript only renders with a session.
  Every selector above is inferred from minified bundles + third-party reports.
- **Inner structure of `.fbb737a4`** — whether it directly contains `.ds-markdown` is unconfirmed.
- **`e47135bc` collapsed-state class** — absent from current CSS *and* JS; may be dead.
- **`.ds-collapsible-text-toggle-button`** exists in CSS but I found no JS reference (may be applied dynamically).
- **Whether `.fbb737a4` / `._74c0879` will survive the next deploy.** They are hashes; precedent says they won't.
- The bundle is a single `main.js`; async chunks exist but I did not enumerate them, so a few component
  class strings may live outside what I searched.

## 7. Bottom line for CSS

- Thinking section: **`.ds-think-content`** hides the reasoning body (stable, semantic) — but only while
  expanded. **`._74c0879`** hides the entire block including the header (hash, brittle).
- User messages: **`.fbb737a4`** is the only hook found, and it is a hash. There is no stable alternative.
- Markdown body: **`.ds-markdown`** — stable and safe.
- Nothing here should be treated as durable across DeepSeek deploys. Prefer attribute/`:has()` fallbacks and
  re-verify against the live DOM once you can log in.
