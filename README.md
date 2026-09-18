# HAMA CODER

A responsive AI website-building workspace powered by React, Vite, Express and the owner's LlamaCoder deployment.

## Start

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
npm start
```

## Features

- Agent Team mode: one model architects/reviews while the other implements/repairs
- DeepSeek V4 Flash and GLM 5.2 model switching
- Controlled virtual-filesystem updates that preserve unchanged files
- Guaranteed multi-file projects (`index.html`, `styles.css`, `script.js`)
- Automatic missing-file, QA and runtime-error repair with a two-round safety limit
- Restricted CSP/iframe preview sandbox with console and crash capture
- JavaScript, HTML, CSS and axe-core accessibility validation
- Real IDE Problems panel with file-targeted diagnostics
- Real-time IDE-style code editor
- Responsive desktop and mobile preview
- ZIP project export
- DuckDuckGo Instant Answer research
- Pollinations Flux image generation
- Canonical virtual filesystem shared by manual edits and both AI models
- IndexedDB autosave with visible save state and conflict detection
- Line-by-line AI change review with per-file accept/reject
- Named version checkpoints, comparison, snapshot preview and file/full rollback
- Visible architect, developer, reviewer, validation and repair stages
- Auto Repair or Review First QA policy
- Click-to-select visual editing with code-backed property controls
- ZIP, file, folder, drag/drop and public GitHub repository import
- Local asset library with generation, compression, rename and reference replacement
- Multi-page preview routing and broken-link validation
- Automated 375px, 768px and 1440px responsive layout audits
- Persistent local project history

## Structure

```text
hama-coder/
├── server/
│   ├── .env
│   └── index.js
├── src/
│   ├── App.jsx
│   ├── main.jsx
│   ├── styles.css
│   ├── builder.css
│   ├── launch.css
│   ├── workbench.css
│   ├── ide.css
│   ├── composer.css
│   ├── tools.css
│   └── agent-tools.css
├── .env.example
├── .gitignore
├── index.html
├── package.json
└── vite.config.js
```

## Backend flow

The browser calls the local Express routes. The server communicates with LlamaCoder, DuckDuckGo and Pollinations so provider details stay out of UI components.

No API key is stored in this project.
