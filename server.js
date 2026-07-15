const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { chromium } = require('playwright');
const dns = require('dns').promises;
const net = require('net');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MAX_CAPTURE = 200;
const MAX_BODY_LEN = 2000;
const TRUNC_PREVIEW = 500;
const GLOBAL_TIMEOUT_MS = 30000;

// Configuration du proxy interne
const PROXY_URL = 'http://localhost:8080';

// Documentation Swagger
const swaggerDocument = YAML.load('./swagger.yaml');

// ---------- Anti-SSRF helpers ----------

function ip4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isPrivateIp(ip) {
  if (!net.isIP(ip)) return false;
  if (net.isIP(ip) === 4) {
    const n = ip4ToInt(ip);
    if ((n & 0xff000000) === ip4ToInt('10.0.0.0')) return true;
    if ((n & 0xfff00000) === ip4ToInt('172.16.0.0')) return true;
    if ((n & 0xffff0000) === ip4ToInt('192.168.0.0')) return true;
    if ((n & 0xff000000) === ip4ToInt('127.0.0.0')) return true;
    if ((n & 0xffff0000) === ip4ToInt('169.254.0.0')) return true;
    if (ip === '0.0.0.0') return true;
    return false;
  } else {
    if (ip === '::1') return true;
    if (ip.slice(0, 2).toLowerCase() === 'fc' || ip.slice(0, 2).toLowerCase() === 'fd') return true;
    if (ip.slice(0, 4).toLowerCase() === 'fe80') return true;
    return false;
  }
}

async function resolveHost(hostname) {
  if (net.isIP(hostname)) return hostname;
  try {
    const res = await dns.lookup(hostname, { family: 0 });
    return res && res.address;
  } catch {
    return null;
  }
}

// ---------- Sanitizers ----------

function sanitizeHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    const lk = k.toLowerCase();
    if (['authorization', 'cookie', 'set-cookie', 'proxy-authorization'].includes(lk)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '...[truncated]' : v;
    }
  }
  return out;
}

function sanitizeBody(b) {
  if (!b) return null;
  if (typeof b !== 'string') {
    try {
      b = JSON.stringify(b);
    } catch {
      b = String(b);
    }
  }
  if (b.length > MAX_BODY_LEN) return b.slice(0, MAX_BODY_LEN) + '...[truncated]';
  return b;
}

// ---------- Rate limiting + concurrency lock ----------

const analyzeLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  message: { error: 'Trop de requêtes, réessaie dans une minute.' }
});

let scanInProgress = false;

// ---------- Documentation API ----------
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// ---------- Route principale ----------

app.post('/analyze', analyzeLimiter, async (req, res) => {
  if (scanInProgress) {
    return res.status(429).json({ error: 'Un scan est déjà en cours, réessaie dans quelques secondes.' });
  }

  const { url } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL manquante ou invalide' });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: 'URL malformée' });
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Schéma non autorisé (seulement http/https)' });
  }

  const firstAddr = await resolveHost(parsed.hostname);
  if (!firstAddr) return res.status(400).json({ error: "Impossible de résoudre le nom d'hôte" });
  if (isPrivateIp(firstAddr)) {
    return res.status(400).json({ error: 'Cible non autorisée (IP privée ou loopback)' });
  }

  scanInProgress = true;
  let browser;
  let finished = false;

  // Garde-fou global : force la fermeture si tout dépasse GLOBAL_TIMEOUT_MS
  const globalTimeout = setTimeout(async () => {
    if (!finished && browser) {
      await browser.close().catch(() => {});
    }
  }, GLOBAL_TIMEOUT_MS);

  const captured = new Map();

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const context = await browser.newContext({ 
      javaScriptEnabled: true,
      proxy: {
        server: PROXY_URL
      }
    });
    const page = await context.newPage();

    await page.route('**/*', async route => {
      const request = route.request();
      const resource = request.resourceType();
      const rUrl = request.url();

      if (['image', 'stylesheet', 'font', 'media'].includes(resource)) {
        return route.abort();
      }
      try {
        const ru = new URL(rUrl);
        if (!['http:', 'https:'].includes(ru.protocol)) return route.abort();
        const addr = await resolveHost(ru.hostname);
        if (!addr) return route.abort();
        if (isPrivateIp(addr)) return route.abort();
      } catch {
        return route.abort();
      }
      return route.continue();
    });

    function addCaptured(key, payload) {
      if (captured.size >= MAX_CAPTURE) return;
      if (!captured.has(key)) captured.set(key, payload);
    }

    page.on('request', request => {
      try {
        const type = request.resourceType();
        if (type === 'xhr' || type === 'fetch') {
          const rawUrl = request.url().split('&_=')[0];
          const key = `${request.method()}:${rawUrl}`;
          addCaptured(key, {
            method: request.method(),
            url: rawUrl,
            headers: sanitizeHeaders(request.headers()),
            postData: sanitizeBody(request.postData()),
            responsePreview: null,
            status: null
          });
        }
      } catch {}
    });

    page.on('response', async response => {
      try {
        const request = response.request();
        const type = request.resourceType();
        if (type === 'xhr' || type === 'fetch') {
          const rawUrl = request.url().split('&_=')[0];
          const key = `${request.method()}:${rawUrl}`;
          const entry = captured.get(key);
          if (entry && !entry.responsePreview) {
            entry.status = response.status();
            const ct = (response.headers()['content-type'] || '').toLowerCase();
            try {
              if (ct.includes('application/json') || ct.startsWith('text/') || ct.includes('json')) {
                const txt = await response.text();
                entry.responsePreview = txt.length > TRUNC_PREVIEW ? txt.slice(0, TRUNC_PREVIEW) + '...[truncated]' : txt;
              } else {
                entry.responsePreview = `[non-text response: ${ct || 'unknown'}]`;
              }
            } catch {
              entry.responsePreview = '[failed to read response]';
            }
          }
        }
      } catch {}
    });

    await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(4000).catch(() => {});
    await page.mouse.wheel(0, 1200).catch(() => {});
    await page.waitForTimeout(2500).catch(() => {});

    const requests = Array.from(captured.values());

    finished = true;
    clearTimeout(globalTimeout);
    await browser.close();
    scanInProgress = false;

    return res.json({
      source: url,
      count: requests.length,
      requests
    });

  } catch (err) {
    finished = true;
    clearTimeout(globalTimeout);
    if (browser) await browser.close().catch(() => {});
    scanInProgress = false;
    return res.status(500).json({ error: "Échec de l'analyse", detail: String(err && err.message ? err.message : err) });
  }
});

app.get('/', (req, res) => res.redirect('/api-docs'));

app.get('/health', (req, res) => res.send('API Finder Service — OK'));

app.listen(PORT, () => console.log(`Service lancé sur le port ${PORT}`));
