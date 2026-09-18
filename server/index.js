import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Load environment variables gracefully (root .env and server/.env if they exist)
dotenv.config();
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const port = Number(process.env.PORT || 5173);
const defaultModel = process.env.LLAMACODER_MODEL || 'deepseek-ai/DeepSeek-V4-Flash-0731';
const allowedModels = new Set(['deepseek-ai/DeepSeek-V4-Flash-0731', 'zai-org/GLM-5.2']);

// CORS & Security headers & body limits
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});
app.use(express.json({ limit: '8mb' }));

/** Detect active AI provider from environment */
function getActiveProvider() {
  if (process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL) {
    return {
      type: 'openai',
      name: 'OpenAI',
      baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      apiKey: process.env.OPENAI_API_KEY || '',
      defaultModel: process.env.OPENAI_MODEL || 'gpt-4o-mini'
    };
  }
  if (process.env.TOGETHER_API_KEY) {
    return {
      type: 'openai',
      name: 'Together AI',
      baseUrl: 'https://api.together.xyz/v1',
      apiKey: process.env.TOGETHER_API_KEY,
      defaultModel
    };
  }
  if (process.env.GROQ_API_KEY) {
    return {
      type: 'openai',
      name: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: process.env.GROQ_API_KEY,
      defaultModel: 'llama-3.3-70b-versatile'
    };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return {
      type: 'openai',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY,
      defaultModel
    };
  }
  if (process.env.OLLAMA_BASE_URL) {
    return {
      type: 'openai',
      name: 'Ollama',
      baseUrl: `${process.env.OLLAMA_BASE_URL.replace(/\/+$/, '')}/v1`,
      apiKey: 'ollama',
      defaultModel: process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b'
    };
  }
  return {
    type: 'llamacoder',
    name: 'LlamaCoder (Free Proxy)',
    baseUrl: process.env.LLAMACODER_BASE_URL || 'https://llamacoder.together.ai',
    defaultModel
  };
}

app.get('/api/status', (_req, res) => {
  const provider = getActiveProvider();
  res.json({
    connected: true,
    provider: provider.name,
    providerType: provider.type,
    model: provider.defaultModel || defaultModel,
    models: [...allowedModels],
    search: 'DuckDuckGo Web & Answers',
    images: 'Pollinations Flux',
    configuredKey: provider.apiKey ? `${provider.apiKey.slice(0, 4)}...${provider.apiKey.slice(-4)}` : null
  });
});

app.get('/api/search', async (req, res) => {
  const query = String(req.query.q || '').trim().slice(0, 300);
  if (!query) return res.status(400).json({ error: 'Search query is required.' });
  try {
    const results = await duckSearch(query);
    res.json(results);
  } catch (error) {
    res.status(502).json({ error: `Search failed: ${error.message}` });
  }
});

app.get('/api/import/github', async (req, res) => {
  try {
    let rawUrl = String(req.query.url || '').trim();
    if (!rawUrl) return res.status(400).json({ error: 'GitHub repository URL is required.' });
    if (!/^https?:\/\//i.test(rawUrl)) {
      rawUrl = `https://${rawUrl.replace(/^https?:?\/?\/?/i, '')}`;
    }
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return res.status(400).json({ error: 'Please enter a valid URL (e.g. https://github.com/owner/repo).' });
    }
    if (parsed.hostname !== 'github.com') {
      return res.status(400).json({ error: 'Only public github.com repositories can be imported.' });
    }
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) {
      return res.status(400).json({ error: 'Repository owner and name are required (e.g. owner/repo).' });
    }
    const [owner, rawRepo] = parts;
    const repository = rawRepo.replace(/\.git$/i, '');
    const requestedBranch = parts[2] === 'tree' ? parts.slice(3).join('/') : '';
    const branches = requestedBranch ? [requestedBranch] : ['main', 'master', 'develop'];
    let upstream;
    for (const branch of branches) {
      try {
        upstream = await fetch(`https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/zip/refs/heads/${branch}`, {
          headers: { 'User-Agent': 'HAMA-CODER/1.0' },
          signal: AbortSignal.timeout(60000)
        });
        if (upstream.ok) break;
      } catch {
        // try next candidate branch
      }
    }
    if (upstream?.status === 403 || upstream?.status === 429) {
      return res.status(429).json({ error: 'GitHub rate limit reached. Please try again in a few moments.' });
    }
    if (!upstream?.ok) {
      return res.status(404).json({ error: `Could not download repository for ${owner}/${repository}. Check repository name and public access.` });
    }
    const size = Number(upstream.headers.get('content-length') || 0);
    if (size > 25 * 1024 * 1024) {
      return res.status(413).json({ error: 'Repository archive exceeds the 25 MB limit.' });
    }
    const data = Buffer.from(await upstream.arrayBuffer());
    if (data.length > 25 * 1024 * 1024) {
      return res.status(413).json({ error: 'Repository archive exceeds the 25 MB limit.' });
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${repository}.zip"`);
    res.send(data);
  } catch (error) {
    res.status(500).json({ error: `GitHub import failed: ${error.message}` });
  }
});

app.get('/api/image', async (req, res) => {
  const prompt = String(req.query.prompt || '').trim().slice(0, 1200);
  if (!prompt) return res.status(400).json({ error: 'Image prompt is required.' });
  const width = clamp(Number(req.query.width) || 1024, 256, 1536);
  const height = clamp(Number(req.query.height) || 1024, 256, 1536);
  try {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&model=flux&safe=true&seed=-1`;
    const upstream = await fetch(url, { headers: { 'User-Agent': 'HAMA-CODER/1.0' }, signal: AbortSignal.timeout(180000) });
    if (!upstream.ok || !upstream.body) {
      const errText = (await upstream.text().catch(() => '')).slice(0, 300);
      return res.status(upstream.status || 502).json({ error: errText || 'Image provider did not return an image.' });
    }
    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('image/')) {
      const errText = (await upstream.text().catch(() => '')).slice(0, 300);
      return res.status(502).json({ error: errText || 'Image provider returned an invalid format.' });
    }
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (error) {
    res.status(502).json({ error: `Image generation failed: ${error.message}` });
  }
});

app.post('/api/chat', async (req, res) => {
  const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
  if (!messages.length) return res.status(400).json({ error: 'At least one message is required.' });
  const model = allowedModels.has(req.body.model) ? req.body.model : defaultModel;
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });

  const provider = getActiveProvider();

  try {
    res.status(200);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-HAMA-CODER-Provider', provider.name);
    res.flushHeaders?.();

    const latestRequest = messages.filter(message => message.role === 'user').at(-1)?.content || '';
    let research = null;
    if (req.body.search === true) {
      try { research = await duckSearch(latestRequest); } catch { research = null; }
    }
    const teamMode = req.body.mode === 'smart';
    const partnerModel = [...allowedModels].find(candidate => candidate !== model) || model;
    const hasExistingBuild = messages.some(message => message.role === 'assistant' && /path\s*=/.test(message.content || ''));

    let plan = '';
    if (teamMode) {
      stage(res, 'architect', 'working', modelName(partnerModel) + ' is designing the architecture');
      try { plan = await collectAI(buildPlanningPrompt(messages, research), partnerModel, controller.signal); }
      catch { plan = ''; }
      if (controller.signal.aborted) return res.end();
      stage(res, 'architect', 'done', modelName(partnerModel) + ' created the architecture');
    }

    stage(res, 'developer', 'working', modelName(model) + ' is editing project files');
    let generated = '';
    await streamAI(buildPrompt(messages, req.body.mode, research, plan), model, controller.signal, token => {
      generated += token;
      res.write(token);
    });
    if (controller.signal.aborted) return res.end();
    stage(res, 'developer', 'done', modelName(model) + ' generated the implementation');

    // Only validate that all 3 core files exist on the initial generation.
    // On follow-up incremental edits, returning only changed files is correct and intended.
    stage(res, 'validation', 'working', 'Checking required files and output contract');
    let missing = !hasExistingBuild ? requiredFilesMissing(generated) : [];
    if (missing.length && !controller.signal.aborted) {
      stage(res, 'repair', 'working', modelName(model) + ` is restoring ${missing.length} missing files`);
      res.write(`\n\n`);
      const repairPrompt = buildRepairPrompt(messages, generated, missing);
      await streamAI(repairPrompt, model, controller.signal, token => { generated += token; res.write(token); });
    }
    if (controller.signal.aborted) return res.end();
    stage(res, 'validation', 'done', 'Required-file validation completed');

    if (teamMode && !controller.signal.aborted) {
      stage(res, 'reviewer', 'working', modelName(partnerModel) + ' is independently reviewing the code');
      let review = '';
      try { review = await collectAI(buildReviewPrompt(messages, generated), partnerModel, controller.signal); }
      catch { review = 'PASS'; }
      if (controller.signal.aborted) return res.end();
      stage(res, 'reviewer', 'done', /^\s*PASS\s*$/i.test(review) ? 'Independent review passed' : 'Independent review found corrections');
      if (!/^\s*PASS\s*$/i.test(review) && review.trim() && !controller.signal.aborted) {
        stage(res, 'repair', 'working', modelName(model) + ' is applying reviewer corrections');
        res.write(`\n\n`);
        await streamAI(buildTeamRepairPrompt(messages, generated, review), model, controller.signal, token => { generated += token; res.write(token); });
      }
    }

    if (!hasExistingBuild) {
      missing = requiredFilesMissing(generated);
      if (missing.length && !controller.signal.aborted) {
        res.write(`\n\n`);
        await streamAI(buildRepairPrompt(messages, generated, missing), model, controller.signal, token => res.write(token));
      }
    }

    stage(res, 'complete', 'done', 'Agent workflow complete · running browser QA');
    res.end();
  } catch (error) {
    if (error.name === 'AbortError') return res.end();
    if (!res.headersSent) res.status(error.status || 502).json({ error: error.message });
    else {
      res.write(`\n\nGeneration error: ${error.message}`);
      res.end();
    }
  }
});

/** Universal AI streaming router */
async function streamAI(prompt, model, signal, onToken) {
  const provider = getActiveProvider();
  if (provider.type === 'openai') {
    return streamOpenAI(prompt, model, signal, onToken, provider);
  }
  return streamLlamaCoder(prompt, model, signal, onToken);
}

/** Collect full AI output */
async function collectAI(prompt, model, signal) {
  let output = '';
  await streamAI(prompt, model, signal, token => { output += token; });
  return output;
}

/** Stream from OpenAI-compatible provider */
async function streamOpenAI(prompt, model, signal, onToken, provider) {
  const messages = [
    { role: 'system', content: 'You are an expert full-stack web developer and UI designer. Follow the user prompt and virtual filesystem contract strictly.' },
    { role: 'user', content: prompt }
  ];
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(provider.apiKey ? { 'Authorization': `Bearer ${provider.apiKey}` } : {})
    },
    body: JSON.stringify({
      model: provider.defaultModel || model,
      messages,
      stream: true,
      temperature: 0.2
    }),
    signal
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw upstreamError(response.status, errorText, `${provider.name} request failed.`);
  }
  if (!response.body) throw upstreamError(502, '', `${provider.name} returned an empty stream.`);

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const token = parseStreamLine(line);
      if (token) onToken(token);
    }
  }
  if (buffer.trim()) {
    const token = parseStreamLine(buffer);
    if (token) onToken(token);
  }
}

/** Stream from LlamaCoder upstream proxy */
async function streamLlamaCoder(prompt, model, signal, onToken) {
  const baseUrl = process.env.LLAMACODER_BASE_URL || 'https://llamacoder.together.ai';
  const created = await fetch(`${baseUrl}/api/create-chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ prompt, model })
  });
  const createdText = await created.text();
  if (!created.ok) throw upstreamError(created.status, createdText, 'Unable to create the LlamaCoder generation.');
  let chat;
  try { chat = JSON.parse(createdText); } catch { throw upstreamError(502, '', 'LlamaCoder returned an invalid create-chat response.'); }
  if (!chat.lastMessageId) throw upstreamError(502, '', 'LlamaCoder did not return a message ID.');

  const upstream = await fetch(`${baseUrl}/api/get-next-completion-stream-promise`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ messageId: chat.lastMessageId, model })
  });
  if (!upstream.ok) throw upstreamError(upstream.status, await upstream.text(), 'LlamaCoder generation failed.');
  if (!upstream.body) throw upstreamError(502, '', 'LlamaCoder returned an empty stream.');

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const token = parseStreamLine(line);
      if (token) onToken(token);
    }
  }
  if (buffer.trim()) {
    const token = parseStreamLine(buffer);
    if (token) onToken(token);
  }
}

/** Search DuckDuckGo with Instant Answers + Web Snippet fallback */
async function duckSearch(query) {
  let answer = '';
  let source = '';
  let sourceUrl = '';
  let related = [];

  try {
    const url = new URL('https://api.duckduckgo.com/');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('no_html', '1');
    url.searchParams.set('no_redirect', '1');
    url.searchParams.set('skip_disambig', '1');
    url.searchParams.set('t', 'hama-coder');
    const response = await fetch(url, { headers: { 'User-Agent': 'HAMA-CODER/1.0' }, signal: AbortSignal.timeout(8000) });
    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      const collect = items => (items || []).forEach(item => item.Topics ? collect(item.Topics) : item.Text && related.push({ title: item.Text, url: item.FirstURL || '' }));
      collect(data.RelatedTopics);
      answer = data.Answer || data.AbstractText || data.Definition || '';
      source = data.AbstractSource || '';
      sourceUrl = data.AbstractURL || '';
    }
  } catch {
    // Instant answer API failed or timed out, fallback to HTML search
  }

  // If Instant Answers returned no descriptive summary, check related topic texts
  if (!answer && related.length) {
    answer = related.slice(0, 4).map(item => item.title).filter(Boolean).join('\n\n');
    sourceUrl = related[0]?.url || '';
    source = 'DuckDuckGo Topics';
  }

  // If still empty, scrape snippets from DuckDuckGo HTML Lite
  if (!answer) {
    try {
      const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const htmlRes = await fetch(htmlUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (htmlRes.ok) {
        const html = await htmlRes.text();
        const snippets = [];
        const regex = /<a class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        while ((match = regex.exec(html)) !== null && snippets.length < 5) {
          const cleanSnippet = match[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim();
          if (cleanSnippet) snippets.push(cleanSnippet);
        }
        if (snippets.length) {
          answer = snippets.join('\n\n');
          source = 'DuckDuckGo Web';
          sourceUrl = htmlUrl;
        }
      }
    } catch {
      // search fallback failed silently
    }
  }

  return { query, answer, source, sourceUrl, related: related.slice(0, 8) };
}

function modelName(model) { return model.includes('GLM') ? 'GLM 5.2' : 'DeepSeek V4 Flash'; }
function stage(res, id, status, label) { res.write(`\n[[HAMA_STAGE:${id}:${status}:${String(label).replace(/[\]\n\r]/g, ' ')}]]\n`); }
function clamp(value, min, max) { return Math.min(max, Math.max(min, Math.round(value))); }

function parseStreamLine(line) {
  let clean = line.trim();
  if (!clean) return '';
  if (clean.startsWith('data:')) {
    clean = clean.slice(5).trim();
  }
  if (!clean || clean === '[DONE]') return '';
  try {
    const parsed = JSON.parse(clean);
    return parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.text || '';
  } catch {
    return '';
  }
}

function requiredFilesMissing(text) {
  const normalized = text.toLowerCase();
  return ['index.html', 'styles.css', 'script.js'].filter(file => !new RegExp(`path\\s*=\\s*["']?${file.replace('.', '\\.')}`).test(normalized));
}

function buildPlanningPrompt(messages, research) {
  const request = messages.filter(message => message.role === 'user').at(-1)?.content || '';
  return `Act only as a senior product designer and software architect. Do not write implementation code. Produce a compact private build plan under 900 words for this request: ${request}\nCover information architecture, visual direction, responsive behavior, interactions, accessibility, loading/empty/error states, and a final QA checklist.${research?.answer ? `\nUseful web research: ${research.answer}\nSource: ${research.sourceUrl}` : ''}`;
}

function buildPrompt(messages, mode = 'smart', research, plan = '') {
  const hasExistingBuild = messages.some(message => message.role === 'assistant' && /path\s*=/.test(message.content || ''));
  const recent = messages.slice(-6).map(({ role, content }) => `${role === 'assistant' ? 'CURRENT VIRTUAL FILESYSTEM SNAPSHOT' : 'USER REQUEST'}:\n${String(content || '').slice(-45000)}`).join('\n\n');
  const intelligence = mode === 'smart'
    ? `A partner model produced this architecture plan. Follow it carefully; another model will independently review your work afterward:\n${plan || 'Plan the architecture, visual system, responsive behavior, interactions and accessibility before coding.'}`
    : 'Prioritize speed while keeping the result complete and functional.';
  const webContext = research?.answer ? `\nRESEARCH CONTEXT (verify and cite in page copy only when useful):\n${research.answer}\nSource: ${research.sourceUrl}\n` : '';
  const fileContract = hasExistingBuild
    ? 'This is a follow-up edit. Act as a controlled virtual-filesystem agent: preserve files that do not need changes and return every changed or newly created file in a complete fenced block with exact path metadata. Never return partial snippets. If coherence requires it, return all three core files.'
    : 'Return ALL THREE complete core files in this exact order: index.html, styles.css, and script.js.';
  return `Create the requested website as a substantial, beautiful, production-quality, mobile-first vanilla web project. ${intelligence}\nInclude rich sections, meaningful interactions, semantic HTML, accessibility, polished animation, responsive states, form validation where relevant, and enough complete code to feel like a real finished product rather than a short demo.${webContext}\nVIRTUAL FILESYSTEM CONTRACT: ${fileContract}\nUse separate fenced blocks exactly like:\n\`\`\`html{path=index.html}\n...\n\`\`\`\n\`\`\`css{path=styles.css}\n...\n\`\`\`\n\`\`\`javascript{path=script.js}\n...\n\`\`\`\nCRITICAL CSS & CODE INTEGRITY RULES:\n- Write clean, modern, modular CSS under 350 lines. Every CSS rule and media query MUST be properly closed with a matching "}".\n- NEVER generate repetitive loops of CSS variables or properties (e.g. NEVER generate dozens or hundreds of --color-chart-1...300). Define at most 6-8 semantic variables in :root (--primary, --secondary, --bg, --surface, --text, --border).\n- NEVER repeat identical CSS blocks, selectors, or dummy text strings.\n- All internal page links must resolve. index.html must link styles.css and script.js. Never inline CSS or JavaScript. Use no React, packages, CDNs, remote fonts, remote images, eval, or document.write. Output code only.\n\n${recent}`;
}

function buildRepairPrompt(messages, generated, missing) {
  const request = messages.filter(m => m.role === 'user').at(-1)?.content || 'the requested website';
  return `The previous generation for “${request}” omitted required project files: ${missing.join(', ')}. Return ONLY the missing files as complete fenced blocks using the exact path metadata. Keep styles concise under 300 lines, fully close all "}" braces, and NEVER generate looping repetitive variables (--color-chart-1...N). They must fully style and power the existing HTML, be responsive, and contain no external dependencies. Do not repeat files that already exist.\n\nExisting output:\n${generated.slice(-30000)}`;
}

function buildReviewPrompt(messages, generated) {
  const request = messages.filter(message => message.role === 'user').at(-1)?.content || 'Build a complete website.';
  return `You are the independent QA reviewer in a two-model coding team. Do not rewrite files. Inspect the implementation against the request and identify only concrete, high-confidence defects: invalid JavaScript, unclosed CSS braces "}", looping repetitive variables, broken interactions, missing requirements, accessibility blockers, mobile overflow, missing loading/empty/error states, unsafe code, or incomplete files. Ignore subjective minor preferences. If there are no material defects, reply exactly PASS. Otherwise return a concise numbered defect report with file paths and precise corrections.\n\nREQUEST:\n${request}\n\nIMPLEMENTATION:\n${generated.slice(-70000)}`;
}

function buildTeamRepairPrompt(messages, generated, review) {
  const request = messages.filter(message => message.role === 'user').at(-1)?.content || 'Build a complete website.';
  return `You are the implementing engineer. A different model independently reviewed your project. Apply every valid finding, preserve working features, keep styles concise without repetitive loops, ensure every "}" brace is closed, and return complete replacement fenced blocks for every file you change. Return at least index.html, styles.css, and script.js so the corrected version is coherent. Output code only; no explanations. Do not use packages, CDNs, remote assets, eval, or document.write.\n\nORIGINAL REQUEST:\n${request}\n\nQA REVIEW:\n${review.slice(0, 12000)}\n\nCURRENT FILES:\n${generated.slice(-70000)}`;
}

function upstreamError(status, raw, fallback) {
  let message = fallback;
  try { const parsed = JSON.parse(raw); message = parsed.error?.message || parsed.message || parsed.error || fallback; }
  catch { if (raw?.trim()) message = raw.slice(0, 500); }
  const error = new Error(String(message)); error.status = status; return error;
}

const isProduction = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');

if (isProduction) {
  app.use(express.static(path.join(root, 'dist')));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
} else {
  const vite = await createViteServer({ root, server: { middlewareMode: true, allowedHosts: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

const server = app.listen(port, '0.0.0.0', () => console.log(`HAMA CODER running on http://0.0.0.0:${port}`));

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
