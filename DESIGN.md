# mcp-former — DESIGN.md

The aesthetic is **developer-tool minimalism**: Linear's precision, Vercel's monochrome restraint, Anthropic's editorial confidence, Resend's typography-led density, Modal's calm dark surfaces. Single accent colour. Generous whitespace. Type does the work.

## Voice

Confident, terse, opinionated. Sentences end with a period. No exclamation marks. No "🚀" or "✨" anywhere. Code-adjacent prose: every claim is testable.

## Colour tokens

```css
:root {
  /* Surfaces — warm-neutral dark, not blue-black */
  --bg:           #0a0a0a;     /* page                 */
  --surface:      #0f0f0f;     /* cards                */
  --surface-2:    #161616;     /* nested cards, inputs */
  --surface-3:    #1d1d1d;     /* hover                */
  --border:       #262626;     /* default 1px          */
  --border-hi:    #3a3a3a;     /* focus / selected     */

  /* Text — high contrast at top, soft mute below */
  --text:         #ededed;
  --text-2:       #a1a1a1;
  --text-3:       #707070;

  /* Single accent — sodium-vapour amber. Used sparingly. */
  --accent:       #ffba50;
  --accent-bg:    rgba(255, 186, 80, 0.08);
  --accent-line:  rgba(255, 186, 80, 0.3);

  /* Semantic */
  --ok:           #58e08e;
  --warn:         #f5cb5c;
  --err:          #f25f5c;

  /* Code surface */
  --code-bg:      #0f0f0f;
  --code-border:  #1d1d1d;
}
```

**Rule:** the accent (amber) appears only on (1) the primary CTA, (2) `cursor`/`focus` rings, (3) the live-streaming status dot, (4) the brand mark. Everywhere else is monochrome.

## Type

```css
font-family:
  ui-sans-serif,
  -apple-system,
  "Inter",
  "Helvetica Neue",
  sans-serif;

font-mono:
  ui-monospace,
  "SF Mono",
  "Geist Mono",
  "JetBrains Mono",
  monospace;
```

**Scale (rem-based, 16px root):**

| Token | Size | Weight | Tracking | Use |
|---|---|---|---|---|
| `display` | 4.5rem (72) | 600 | -0.04em | hero only |
| `h1` | 2.25rem (36) | 600 | -0.02em | section heads |
| `h2` | 1.5rem (24) | 600 | -0.01em | card titles |
| `body` | 0.9375rem (15) | 400 | 0 | default |
| `mono` | 0.875rem (14) | 400 | 0 | code, terminals |
| `caption` | 0.8125rem (13) | 400 | 0 | dim notes |
| `micro` | 0.6875rem (11) | 500 | 0.06em (uppercase) | tags, eyebrows |

Line-height: `1.5` for body, `1.15` for display/headings, `1.6` for code.

## Layout

- **Container:** `max-w-[1080px]` centre, `px-6` mobile, `px-10` desktop.
- **Grid:** 12-col, `gap-6` (24px). Hero is asymmetric — heavy left.
- **Section rhythm:** 96px between major sections, 48px between sub-sections. Mathematical, not vibes-based.
- **Border radius:** `8px` small, `12px` cards, `16px` modal/hero card. Never `9999` (no pills outside chips).

## Effects (used sparingly)

- **Borders** beat shadows. `1px solid var(--border)`. Hover bumps to `--border-hi`. Shadow only on the primary CTA: `0 1px 2px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,186,80,0.4)`.
- **Transitions:** `150ms ease` on colour, `200ms ease` on transform. Never longer.
- **Hover on cards:** background steps from `--surface` to `--surface-3`, border to `--border-hi`. No scale, no lift, no glow.
- **Focus ring:** `outline: 2px solid var(--accent); outline-offset: 2px;`.

## Components

### Brand mark
Wordmark: `mcp-former` in mono, weight 500, letter-spacing `-0.02em`. Decorative dot to the left in accent: `▰` glyph (one box). No icon-style logo.

### Primary CTA
```html
<button class="cta">Generate MCP bundle <span class="caret">→</span></button>
```
Accent fill, near-black text (`#0a0a0a`), `1px` accent border. The caret is `→` (U+2192), nudged on hover.

### Input field
Single tall input. No labels above — placeholder in `--text-3`, switches to mono once typed. Below it, a live "detection chip" in `--text-2` showing inferred type ("⤷ GitHub URL", "✓ built-in: kubectl"). The chip is the form's instant feedback — replaces traditional helper text.

### Code surface (terminal pane)
- Background `--code-bg`, `--code-border`.
- Monospace, `13.5px`.
- Streaming logs render with ANSI colour preserved.
- Top-right: a `● running` dot in accent, with a barely-visible 1.4s pulse.
- Bottom-right: copy button on hover only.

### Cards (registry)
- Surface, `1px` border, `12px` radius.
- 16px padding, no nested shadows.
- Header: tool name in mono `15px`, version in `--text-3` mono right-aligned.
- Body: 13px description, two lines max.
- Footer: 11px uppercase tag chips, accent text on `--accent-bg`.

### Tabs
Underline-only. No backgrounds, no pills. Inactive `--text-2`, active `--text` with a `2px` accent line below.

## Motion budget

The whole app gets **three** motion behaviours, end of list:

1. **Fade+lift on first paint.** Hero content rises 8px and fades in over 400ms `cubic-bezier(0.2, 0.8, 0.2, 1)`. Once.
2. **Streaming pulse.** The status dot scales 1 → 1.15 → 1 over 1400ms infinite. Respects `prefers-reduced-motion`.
3. **Caret nudge.** Primary CTA's `→` translates `4px` right on hover, 200ms.

Anything else is layout shift and should be deleted.

## Anti-patterns (do not ship)

- ❌ Gradients. Single solid colours only.
- ❌ Drop shadows on cards. Borders carry the weight.
- ❌ Glass / backdrop-blur. We are not Apple Music.
- ❌ Emoji as icons. Use SVG (Lucide stroke 1.5).
- ❌ Multiple accent colours. The amber is alone.
- ❌ Centre-aligned body text. Left-align always except hero.
- ❌ Skeuomorphic loaders. Spinner is a single rotating segment, no rings.
- ❌ Big rounded corners on inputs (`9999px`). Inputs are `8px`.

## Reference signal

If a screenshot of the page would be confusable for Linear, Vercel, or Resend, you've hit the mark. If it looks like a generic Tailwind template with a gradient hero, start over.
