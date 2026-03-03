# Unravel

AI-powered error diagnostics for React and Next.js. Replaces the default error overlay with root cause analysis, fix guides, and AI-ready prompts.

When an error occurs in development, instead of just a stack trace, you see **why** it happened, which files are affected, and exactly how to fix it.

## Quick Start

**Install:**

```bash
npm install unravel
```

**Configure** (one line in your Next.js config):

```js
// next.config.js
const withUnravel = require("unravel/next");
module.exports = withUnravel({
  // your existing Next.js config
});
```

**Add your API key:**

```bash
# .env
UNRAVEL_API_KEY=sk-ant-...
```

Get a key at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys).

That's it. Start your dev server and trigger an error — you'll see the Unravel overlay instead of the default one.

## What You Get

When an error occurs, Unravel shows a two-panel overlay:

**Left panel** — The standard stack trace you're used to.

**Right panel** — AI-powered analysis:
- **Root cause** — What actually went wrong and why (not just the symptom)
- **Confidence level** — How certain the analysis is (high/medium/low)
- **Affected files** — Which files are involved, what's wrong in each, and how to fix them
- **Fix guide** — Step-by-step instructions to resolve the error
- **AI prompt** — A copy-paste prompt you can give to Claude Code, Cursor, or Copilot to auto-fix the issue
- **Prevention tip** — How to avoid this class of error in the future

## How It Works

1. **Code indexer** — On startup, Unravel parses your project using SWC (the same parser Next.js uses) and builds a dependency graph of all your files, imports, exports, components, and hooks.

2. **File watcher** — Watches for changes and incrementally updates the graph, so it always reflects your current code.

3. **Error interception** — When an error occurs, Unravel catches it via an error boundary (React errors) and global event listeners (unhandled exceptions and promise rejections).

4. **Context gathering** — Traces the error through the dependency graph to find affected files, recent git changes, data flow paths, and related components.

5. **AI analysis** — Sends the gathered context to Claude, which identifies the root cause and generates a diagnosis with specific fixes.

6. **Overlay** — Displays everything in a clean overlay that replaces the default error screen.

## Target Errors

Unravel is specifically optimized for the three most common and painful React/Next.js errors:

### Hydration Mismatches
*"Text content does not match server-rendered HTML"*

Unravel traces the component tree to find where server output diverges from client output — usually a `Date`, `window` reference, or conditional rendering based on browser state.

### Cannot Read Properties of Undefined
*A crash in component X, line Y*

Unravel walks the prop chain and data flow **backwards** from the crash point to find where the undefined value was actually introduced — often a parent component, API response, or missing null check several components up.

### Unhandled Promise Rejections
*A failed fetch or unhandled rejection*

Unravel checks the API route (if it's a Next.js API route), the fetch call, and the component's error handling to explain the full chain of failure.

## Configuration

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `UNRAVEL_API_KEY` | Your Anthropic API key (required for AI analysis) | — |
| `UNRAVEL_PORT` | Port for the analysis server | `4839` |
| `UNRAVEL_PROJECT_ROOT` | Project root directory | `process.cwd()` |

### Using the Error Boundary Directly

If you want to use the error boundary without the Next.js plugin:

```tsx
import { UnravelErrorBoundary } from "unravel/overlay";

function App() {
  return (
    <UnravelErrorBoundary>
      <YourApp />
    </UnravelErrorBoundary>
  );
}
```

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Esc` | Dismiss the overlay |

## Requirements

- Node.js >= 18
- React >= 17
- Next.js >= 13 (for the plugin)
- An [Anthropic API key](https://console.anthropic.com/settings/keys)

## Troubleshooting

**"Unravel API key is not configured"**
Add `UNRAVEL_API_KEY=sk-ant-...` to your `.env` file and restart the dev server.

**Overlay not showing**
Check that the analysis server is running — visit `http://localhost:4839/health` in your browser. If it's not running, make sure `withUnravel` is wrapping your Next.js config.

**"Port 4839 is already in use"**
Another Unravel server may be running from a previous session. Kill it with `lsof -ti:4839 | xargs kill` or set a different port via `UNRAVEL_PORT`.

**Analysis is slow**
The first analysis may take a few seconds while Claude processes the context. Subsequent identical errors are cached for 5 minutes.

## How It's Built

- **SWC** for AST parsing (same parser Next.js uses — fast, handles TS/TSX/JSX natively)
- **Chokidar** for file watching
- **Express** for the local analysis server
- **Claude API** (Sonnet) for error analysis
- **simple-git** for git history integration
- Overlay uses inline styles only — no CSS imports, no build pipeline interference

## License

MIT
