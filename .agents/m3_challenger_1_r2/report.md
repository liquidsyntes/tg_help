# Adversarial Challenge Report — Milestone 3 (Rendering & Validation)

- **Date**: 2026-09-21
- **Agent**: `m3_challenger_1_r2` (teamwork_preview_challenger)
- **Scope**: `HtmlSanitizer`, `HtmlSplitter`, `TelegramRenderer`, `TemplatesModule`, `MediaModule`
- **Verdict**: **REQUEST_CHANGES**

---

## 1. Challenge Summary

**Overall risk assessment**: **HIGH**

While `HtmlSanitizer` demonstrates high robustness against malicious injection vectors (scripts, iframes, onerror handlers, JavaScript protocols, tag smuggling) and cleanly balances unclosed and malformed HTML tags via LIFO stack unwinding, **a critical boundary overflow vulnerability was discovered and empirically reproduced in `HtmlSplitter` and `TelegramRenderer`**:

When formatted text contains active open HTML tags at or near Telegram's message boundary (1024 characters for media captions, 4096 characters for pure text), `HtmlSplitter.splitHtml()` chooses a cut point $\le \text{maxLength}$ **without reserving space for the closing tag suffix (`closingSuffix`)**. When `closingSuffix` is appended to `part1`, the resulting caption or text message length strictly exceeds Telegram's hard limits (e.g. 1036 > 1024, 4123 > 4096). Consequently, `TelegramRenderer` outputs `TelegramPayload` messages that the Telegram Bot API (`sendPhoto`, `sendMessage`, `sendMediaGroup`) will reject with `HTTP 400 Bad Request: message caption is too long` or `message is too long`.

---

## 2. Challenges & Findings

### [High Severity] Challenge 1: `HtmlSplitter` Boundary Overflow Exceeds Telegram Hard Limits (1024 / 4096)

- **Assumption Challenged**:
  The implementation assumes that `HtmlSplitter.splitHtml(html, maxLength)` and `HtmlSplitter.splitIntoChunks(html, maxLength)` produce message chunks that strictly satisfy `part.length <= maxLength`.
- **Attack / Stress Scenario**:
  A post author creates a post with media and long rich-text formatting (e.g., text enclosed in `<a>`, `<b>`, `<i>`, `<u>`, `<blockquote>`) where the text length exceeds 1024 characters (e.g. 1200 characters).
  1. `HtmlSplitter.findOptimalCutPoint(html, 1024)` finds a word break near the limit (e.g. at offset 1018).
  2. `HtmlSplitter.getActiveOpenTags()` identifies active open tags requiring closing suffix `</blockquote></u></i></b></a>` (26 characters).
  3. `HtmlSplitter` computes `part1 = html.slice(0, cutPoint).trimEnd() + closingSuffix`.
  4. `part1.length` becomes `1018 + 26 = 1044` characters (> 1024 limit).
  5. `TelegramRenderer.render` assigns `messages[0].caption = part1` (1044 characters).
- **Blast Radius**:
  When Milestone 4's BullMQ publishing worker executes `sendPhoto(chatId, fileId, { caption: messages[0].caption })`, the Telegram Bot API returns `HTTP 400 Bad Request: message caption is too long`. The publishing job retries 3 times, exhausts exponential backoff, transitions the post to `PUBLISH_FAILED`, and completely blocks publication of valid editorial content.
  The same defect occurs for text posts exceeding 4096 characters: `splitIntoChunks` generates chunks of 4111–4123 characters, which Telegram API rejects with `HTTP 400 Bad Request: message is too long`.
- **Empirical Evidence**:
  - `tests/empirical-m3-verification.ts`:
    - Caption split stress test: `limit = 1024`, `actual part1.length = 1036` (+12 chars over limit).
    - Message split stress test: `limit = 4096`, `actual part1.length = 4123` (+27 chars over limit).
    - `TelegramRenderer.render` test: `Message 0 caption length = 1036` (+12 chars over limit).
  - `tests/unit/adversarial-empirical-m3.spec.ts`:
    - Test 3.10: `part1 length: 1038` (> 1024).
    - Test 3.11: `part1 length: 4111` (> 4096).
- **Required Mitigation**:
  In `src/modules/rendering/html-splitter.ts`, update `splitHtml(html, maxLength)`:
  The cut point search MUST ensure that `cutPoint + closingSuffix.length <= maxLength`.
  Specifically:
  ```ts
  let safeLimit = maxLength;
  let cutPoint = this.findOptimalCutPoint(html, safeLimit);
  let activeTags = this.getActiveOpenTags(html.slice(0, cutPoint));
  let closingSuffix = activeTags.slice().reverse().map((t) => `</${t.tagName}>`).join('');

  // If closing suffix pushes part1 over maxLength, adjust safeLimit and recalculate
  while (cutPoint + closingSuffix.length > maxLength && safeLimit > 0) {
    safeLimit = maxLength - closingSuffix.length;
    cutPoint = this.findOptimalCutPoint(html, safeLimit);
    activeTags = this.getActiveOpenTags(html.slice(0, cutPoint));
    closingSuffix = activeTags.slice().reverse().map((t) => `</${t.tagName}>`).join('');
  }
  ```

---

## 3. Detailed Stress Test Results

### Category 1: Malicious Injection Challenge (17/17 PASS)

| Test ID | Injection Vector | Expected Sanitization | Actual Result | Status |
|---|---|---|---|:---:|
| 1.1 | `<script>alert(1)</script>` | Tag and inner script content stripped | Stripped completely | **PASS** |
| 1.2 | `<SCRIPT SRC="https://evil.com/xss.js">` | Tag and external URL stripped | Stripped completely | **PASS** |
| 1.3 | `Text <script>alert("unclosed")` | Unclosed script neutralized | Tag stripped, runnable script absent | **PASS** |
| 1.4 | `<iframe src="evil.com">payload</iframe>` | `<iframe>` and inner payload stripped | Stripped completely | **PASS** |
| 1.5 | `<iframe src="javascript:alert(1)">` | Unclosed iframe with javascript URI stripped | Stripped completely | **PASS** |
| 1.6 | `<img src=x onerror=alert(1)>` | `<img>` and `onerror` handler stripped | Stripped completely | **PASS** |
| 1.7 | `<img src="x" onerror="alert(1)"/>` | Self-closing `<img>` stripped | Output empty | **PASS** |
| 1.8 | `<a href="javascript:alert(1)">Click</a>` | Disallowed protocol stripped, inner text kept | Returns `Click` without `<a>` | **PASS** |
| 1.9 | `<a href="JAVASCRIPT:void(0)">Link</a>` | Case-insensitive protocol matching | Returns `Link` without `<a>` | **PASS** |
| 1.10 | `data:`, `vbscript:`, `file:///etc/passwd` | Disallowed protocols stripped | All tags stripped, text kept | **PASS** |
| 1.11 | `<div onclick="alert(1)">Text</div>` | Unsupported tag & event handler stripped | Returns `Text` | **PASS** |
| 1.12 | `<b onmouseover="alert(1)" id="b1" style="...">` | Handlers & styling stripped from allowed tag | Returns `<b>Bold Content</b>` | **PASS** |
| 1.13 | `<a href="https://..." onclick="steal()">` | Handlers stripped while retaining valid href | Returns `<a href="...">Safe Link</a>` | **PASS** |
| 1.14 | `<style>`, `<object>`, `<embed>` | Dangerous tags and contents stripped | Stripped completely | **PASS** |
| 1.15 | `<scr<script>ipt>alert(1)</script>` | Tag smuggling / nested tag injection | Neutralized, no executable script | **PASS** |
| 1.16 | `tg://resolve?domain=...` and `https://` | Allowed Telegram protocols preserved with `&` escaping | Preserved: `&` escaped as `&amp;` | **PASS** |
| 1.17 | `code class="language-ts"` vs disallowed class | Whitelisted `language-*` allowed, others stripped | Whitelisted kept, others stripped | **PASS** |

### Category 2: Unclosed and Malformed HTML Tag Balancing Challenge (12/12 PASS)

| Test ID | Malformed / Edge Input | Expected Behavior | Actual Result | Status |
|---|---|---|---|:---:|
| 2.1 | `<b><i><u><s><code><pre><blockquote>Text` | Auto-close in reverse LIFO stack order | Correctly closed: `</blockquote></pre>...</b>` | **PASS** |
| 2.2 | `<b>text</i>` | Rogue `</i>` ignored; `<b>` closed by stack | `<b>text</b>` | **PASS** |
| 2.3 | `Rogue</b> closing</i> tags</a>` | Rogue closing tags on empty stack ignored | `Rogue closing tags` | **PASS** |
| 2.4 | `<b><i>Overlap</b></i>` | Overlapping tags unwound correctly | `<b><i>Overlap</i></b>` | **PASS** |
| 2.5 | `<b>1 <i>2 <u>3</b> 4</i> 5</u>` | Early parent close unwinds child stack | `<b>1 <i>2 <u>3</u></i></b> 4 5` | **PASS** |
| 2.6 | `x < y & y > z. But &amp; already escaped` | Raw `<, >, &` escaped without double-escaping | `x &lt; y &amp; y &gt; z. But &amp; ...` | **PASS** |
| 2.7 | `&fake; &unknown; &123; &Alone` | Unknown/invalid entities escaped | `&amp;fake; &amp;unknown; ...` | **PASS** |
| 2.8 | `<div><p>Text 1</p><span><b>bold</b></span></div>` | Layout tags stripped; inner text/markup kept | `Text 1<b>bold</b>` | **PASS** |
| 2.9 | `<strong>`, `<em>`, `<ins>`, `<strike>`, `<del>` | Normalized to `<b>`, `<i>`, `<u>`, `<s>` | All canonicalized to Telegram tags | **PASS** |
| 2.10 | `<br>`, `<br/>`, `<br />` | Converted to newline `\n` | Replaced by `\n` | **PASS** |
| 2.11 | `''`, `null`, `undefined`, `'   '` | Graceful empty string handling | Returns `''` and `'   '` without crash | **PASS** |
| 2.12 | `<b >spaced</b>`, `<i / >slash</i>` | Unusual spacing / trailing slashes in tags | Safely handled | **PASS** |

### Category 3: Multi-Message Boundary Splitting & TelegramRenderer (8 PASS, 3 FAIL)

| Test ID | Stress Scenario | Expected Behavior | Actual Result | Status |
|---|---|---|---|:---:|
| 3.1 | Plain text 4500 chars | Split into multiple chunks $\le 4096$ | Split into 2 chunks $\le 4096$ | **PASS** |
| 3.2 | Formatted 5000 chars across boundary | Tags closed in chunk 1, reopened in chunk 2 | `</i></b></a>` at chunk 1 end, reopened in chunk 2 | **PASS** |
| **3.3** | **Open tags near 1024 caption limit** | **`part1.length <= 1024`** | **`part1.length = 1036` (+12 overflow)** | **FAIL** |
| **3.4** | **Open tags near 4096 message limit** | **`part1.length <= 4096`** | **`part1.length = 4123` (+27 overflow)** | **FAIL** |
| **3.4b** | **`TelegramRenderer.render` photo with 1200 char formatted body** | **`messages[0].caption.length <= 1024`** | **`caption.length = 1036` (+12 overflow)** | **FAIL** |
| 3.5 | Single photo + 2550 char text | Split to Message 0 (photo) + Message 1 (text) | Msg 0: photo (len 1016), Msg 1: text (len 1567) | **PASS** |
| 3.6 | Media group + 2550 char text | Split to Message 0 (album) + Message 1 (text) | Msg 0: album (lead caption 1016, item 2 null), Msg 1: text | **PASS** |
| 3.7 | Massive post (11,660 chars) + photo | Split into 3+ sequential messages | Msg 0: photo, Msg 1..N: text <= 4096 | **PASS** |
| 3.8 | Natural boundaries preference | Splits at `\n\n`, `\n`, sentence, word | Paragraph and line breaks respected | **PASS** |
| 3.9 | HTML entity split avoidance | Never cuts in middle of `&amp;` or `&lt;` | Entity boundary protected | **PASS** |
| 3.10 | Pathological unbroken 5000 chars | Chunks without infinite loop | 2 chunks (4096 + 904) | **PASS** |

---

## 4. Unchallenged Areas

- Telegram Bot API network latency and live server responses (simulated locally via unit/integration harnesses; actual network calls scoped to Milestone 4).
- GrammY wizard UI callback flows (interactive bot session state is scoped to Milestone 5).

---

## 5. Conclusion & Verdict

**Verdict**: **REQUEST_CHANGES**

`HtmlSanitizer` is well-implemented and fully satisfies Security Dimension 1 and Tag Balancing Dimension 2.
However, `HtmlSplitter` and `TelegramRenderer` fail Dimension 3 under boundary conditions: appending closing tags pushes message length beyond Telegram's hard limits (1024 for captions, 4096 for messages), which will cause Telegram Bot API to reject valid publications with HTTP 400 Bad Request.

The worker must implement tag-aware length budgeting in `HtmlSplitter.splitHtml()` so that `part1.length <= maxLength` is strictly guaranteed regardless of open tag depth.
