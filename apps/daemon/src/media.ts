/**
 * Media generation dispatcher.
 *
 * Every surface (image) flows through one entry point — `generateMedia`.
 * It picks the right provider, resolves credentials, validates args, and
 * dispatches to a renderer. The contract with the agent has its own
 * surface-specific system-prompt file.
 *
 * Architecture:
 *   agent shell → od media generate → daemon HTTP POST /media/generate
 *   → generateMedia → render* → write file → respond JSON
 *
 * Stubs: when a provider has no real integration yet, we can optionally
 * write tiny placeholder bytes (1×1 transparent PNG) so the chat-agent
 * loop doesn't dead-end, but production builds disable this by default.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { stat, readFile } from 'node:fs/promises';
import {
  type AudioKind,
  type MediaModel,
  type MediaProvider,
  type MediaSurface,
  MEDIA_ASPECTS,
  MEDIA_PROVIDERS,
  findMediaModel,
  findProvider,
} from './media-models.js';
import {
  modelsForSurface as modelsForSurfaceFromRegistry,
} from './media-models.js';
import { resolveProviderConfig } from './media-config.js';
import { ensureProject, kindFor, mimeFor, sanitizeName } from './projects.js';

type ProviderConfig = Awaited<ReturnType<typeof resolveProviderConfig>>;

interface ImageRef {
  path: string;
  abs: string;
  mime: string;
  size: number;
  dataUrl: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorStringProp(err: unknown, key: string): string {
  return isRecord(err) && typeof err[key] === 'string' ? err[key] : '';
}
const NANOBANANA_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const NANOBANANA_DEFAULT_MODEL = 'gemini-3.1-flash-image-preview';
const NANOBANANA_DEFAULT_IMAGE_SIZE = '1K';
const IMAGE_ASPECT_RATIOS = new Set(MEDIA_ASPECTS);

const DEFAULT_OUTPUT_BY_SURFACE: Record<MediaSurface, string> = {
  image: 'image.png',
  video: 'video.mp4',
  audio: 'audio.mp3',
};

const SURFACES = new Set<MediaSurface>(['image']);

const DEFAULT_ASPECT = '1:1';

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

function resolveModelAliases(modelId: string): string {
  return modelId;
}

function resolveProviderDef(
  providerId: string,
): MediaProvider {
  const def = findProvider(providerId);
  if (!def) {
    throw new Error(
      `unknown media provider "${providerId}". Check OD_MEDIA_PROVIDER (or the provider id in your model's definition). Known providers: ${MEDIA_PROVIDERS.map(
        (p) => p.id,
      ).join(', ')}`,
    );
  }
  return def;
}

function modelsForSurface(
  surface: MediaSurface,
  _unused?: unknown,
): MediaModel[] {
  return modelsForSurfaceFromRegistry(surface);
}

// ---------------------------------------------------------------------------
// Project image resolution
// ---------------------------------------------------------------------------

async function resolveProjectImage(rel: unknown, projectDir: string): Promise<ImageRef | null> {
  if (typeof rel !== 'string' || !rel.trim()) return null;
  const projectRootResolved = path.resolve(projectDir);
  const abs = path.resolve(projectRootResolved, rel.trim());
  if (
    abs !== projectRootResolved &&
    !abs.startsWith(projectRootResolved + path.sep)
  ) {
    throw new Error(
      `--image path "${rel}" resolves outside the project directory.`,
    );
  }
  let info;
  try {
    info = await stat(abs);
  } catch {
    throw new Error(`--image not found: ${rel}`);
  }
  if (!info.isFile()) {
    throw new Error(`--image is not a regular file: ${rel}`);
  }
  const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
  if (info.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `--image too large (${info.size} bytes; max ${MAX_IMAGE_BYTES}).`,
    );
  }
  const bytes = await readFile(abs);
  const ext = path.extname(abs).toLowerCase();
  const mime = ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  })[ext];
  if (!mime) {
    throw new Error(
      `--image has unsupported extension "${ext}". Use png, jpg, jpeg, webp, or gif.`,
    );
  }
  return {
    path: rel.trim(),
    abs,
    mime,
    size: bytes.length,
    dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
  };
}

function clampNumber(value: unknown, allowed: number[]): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const first = allowed[0];
  if (first === undefined) return undefined;
  let best = first;
  let bestDelta = Math.abs(n - best);
  for (const c of allowed) {
    const delta = Math.abs(n - c);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = c;
    }
  }
  return best;
}

function clampWithWarning(
  value: number | undefined | null,
  allowed: number[],
  label: string,
): { value: number | undefined; warning?: string } {
  if (value === undefined || value === null) return { value: undefined };
  const clamped = clampNumber(value, allowed);
  if (clamped === undefined) return { value: undefined };
  if (clamped !== value) {
    return {
      value: clamped,
      warning: `--${label} ${value}s clamped to nearest allowed value: ${allowed.join(', ')}s (used ${clamped}s).`,
    };
  }
  return { value: clamped };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export interface MediaGenerateArgs {
  projectRoot: string;
  projectsRoot: string;
  projectId: string;
  surface: MediaSurface;
  model: string;
  prompt?: string;
  output?: string;
  aspect?: string;
  length?: number;
  duration?: number;
  voice?: string;
  audioKind?: AudioKind;
  provider?: string;
  compositionDir?: string;
  image?: string;
  language?: string;
  onProgress?: (line: string) => void;
}

export interface MediaGenerateResult {
  name: string;
  size: number;
  mtime: number;
  kind: string;
  mime: string;
  model: string;
  surface: MediaSurface;
  providerNote: string;
  providerId: string;
  providerError: string | null;
  usedStubFallback: boolean;
  intentionalStub: boolean;
  warnings: string[];
}

interface MediaContext {
  surface: MediaSurface;
  projectRoot: string;
  model: string;
  prompt: string;
  aspect: string;
  provider: MediaProvider;
  imageRef: ImageRef | null;
}

interface RenderResult {
  bytes: Buffer;
  providerNote: string;
  suggestedExt?: string;
}

class StubProviderDisabledError extends Error {
  constructor(modelId: string) {
    super(
      `No renderer registered for model "${modelId}". ` +
      'Set OD_MEDIA_ALLOW_STUBS=1 to write placeholder files while integrations mature.',
    );
    this.name = 'StubProviderDisabledError';
  }
}

function stubsAllowed(): boolean {
  return process.env.OD_MEDIA_ALLOW_STUBS === '1';
}

export async function generateMedia(
  args: MediaGenerateArgs,
): Promise<MediaGenerateResult> {
  const {
    projectRoot,
    projectsRoot,
    projectId,
    surface = 'image',
    model: rawModel,
    prompt,
    output,
    aspect = DEFAULT_ASPECT,
    length: _length,
    duration: _duration,
    voice: _voice,
    audioKind: _audioKind,
    provider: providerId,
    compositionDir: _compositionDir,
    image: imagePath,
    language,
    onProgress,
  } = args;

  if (!projectRoot) {
    throw new Error('projectRoot required');
  }
  if (!projectsRoot) {
    throw new Error('projectsRoot required');
  }
  if (typeof projectId !== 'string' || !projectId) {
    throw new Error('projectId required');
  }
  if (!SURFACES.has(surface)) {
    throw new Error(
      `unsupported surface "${surface}". Must be one of: ${[...SURFACES].join(', ')}`,
    );
  }
  if (!prompt || !String(prompt).trim()) {
    throw new Error('--prompt (or PROMPT env) is required');
  }
  const modelId = resolveModelAliases(rawModel || '');
  if (!modelId) {
    throw new Error('--model is required');
  }

  const modelDef = findMediaModel(modelId);
  if (!modelDef) {
    throw new Error(
      `unknown model: ${modelId}. Pass --model from the registered list (see /api/media/models).`,
    );
  }

  const model = modelId;
  const def = providerId
    ? resolveProviderDef(providerId)
    : resolveProviderDef(modelDef.provider);

  const candidates = modelsForSurface(surface);
  if (
    candidates.length > 0 &&
    !candidates.some((m) => m.id === model)
  ) {
    const ids = candidates.map((m) => m.id).join(', ');
    const where = 'in the media-models registry';
    throw new Error(
      `model "${model}" is not registered for "${surface}" ${where}. Allowed: ${ids}`,
    );
  }

  // Validate aspect ratio
  if (aspect && !IMAGE_ASPECT_RATIOS.has(aspect)) {
    throw new Error(
      `unsupported aspect "${aspect}" for image. Supported: ${[...IMAGE_ASPECT_RATIOS].join(', ')}`,
    );
  }

  const dir = await ensureProject(projectsRoot, projectId);
  const autoOut = autoOutputName(surface, model);
  const safeOut = sanitizeName(output || autoOut);

  const imageRef = imagePath
    ? await resolveProjectImage(imagePath, dir)
    : null;

  const ctx: MediaContext = {
    surface,
    projectRoot,
    model,
    prompt: String(prompt).trim(),
    aspect: aspect || DEFAULT_ASPECT,
    provider: def,
    imageRef,
  };

  const credentials = await resolveProviderConfig(projectRoot, def.id);

  let bytes: Buffer;
  let providerNote: string;
  let suggestedExt: string | undefined;
  let providerError: string | null = null;
  let usedStubFallback = false;
  let intentionalStub = false;
  try {
    if (def.id === 'openai' && surface === 'image') {
      const result = await renderOpenAIImage(ctx, credentials);
      bytes = result.bytes;
      providerNote = result.providerNote;
      suggestedExt = result.suggestedExt;
    } else if (def.id === 'volcengine' && surface === 'image') {
      const result = await renderVolcengineImage(ctx, credentials);
      bytes = result.bytes;
      providerNote = result.providerNote;
      suggestedExt = result.suggestedExt;
    } else if (def.id === 'grok' && surface === 'image') {
      const result = await renderGrokImage(ctx, credentials);
      bytes = result.bytes;
      providerNote = result.providerNote;
      suggestedExt = result.suggestedExt;
    } else if (def.id === 'nanobanana' && surface === 'image') {
      const result = await renderNanoBananaImage(ctx, credentials);
      bytes = result.bytes;
      providerNote = result.providerNote;
      suggestedExt = result.suggestedExt;
    } else {
      if (!stubsAllowed()) {
        throw new StubProviderDisabledError(model);
      }
      const result = await renderStub(ctx, safeOut);
      bytes = result.bytes;
      providerNote = result.providerNote;
      intentionalStub = true;
    }
  } catch (err) {
    if (err instanceof StubProviderDisabledError) {
      throw err;
    }
    if (!stubsAllowed()) {
      throw err;
    }
    const stub = await renderStub(ctx, safeOut);
    bytes = stub.bytes;
    const msg = errorMessage(err);
    providerNote = `[${def.id} error → stub] ${msg}`;
    providerError = msg;
    usedStubFallback = true;
    try {
      console.error(
        `[media] ${def.id}/${surface}/${model} failed: ${msg}`,
      );
    } catch {
      // best-effort logging only
    }
  }
  if (intentionalStub || usedStubFallback) {
    providerNote = `[stub] ${providerNote}`;
  }

  const out = suggestedExt
    ? safeOut.replace(/(\.[^.]+)$/i, '') + suggestedExt
    : safeOut;
  const dest = path.resolve(dir, out);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, bytes);
  const written = await stat(dest);

  const result: MediaGenerateResult = {
    name: path.basename(dest),
    size: written.size,
    mtime: written.mtimeMs,
    kind: kindFor(path.basename(dest)),
    mime: mimeFor(path.basename(dest)),
    surface,
    model,
    providerId: def.id,
    providerNote,
    providerError,
    usedStubFallback: intentionalStub ? false : usedStubFallback,
    intentionalStub,
    warnings: [],
  };

  return result;
}

function autoOutputName(surface: MediaSurface, model: string): string {
  const base = DEFAULT_OUTPUT_BY_SURFACE[surface] || 'artifact.bin';
  const stamp = Date.now().toString(36);
  const slug = String(model).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  return `${stem}-${slug}-${stamp}${ext}`;
}

function defaultAspectFor(surface: MediaSurface): string | undefined {
  if (surface === 'image') return '1:1';
  return undefined;
}

// ---------------------------------------------------------------------------
// Provider: OpenAI Images API
// ---------------------------------------------------------------------------

const AZURE_DEFAULT_API_VERSION = '2024-02-01';
async function renderOpenAIImage(ctx: MediaContext, credentials: ProviderConfig): Promise<RenderResult> {
  if (!credentials.apiKey) {
    throw new Error('no OpenAI credential — configure an API key in Settings, set OPENAI_API_KEY, or refresh Codex/Hermes OAuth');
  }
  const rawBase = credentials.baseUrl || 'https://api.openai.com/v1';
  const azure = detectAzureEndpoint(rawBase);
  const url = buildOpenAIImageUrl(rawBase, azure);

  const body: Record<string, unknown> = {
    prompt: ctx.prompt || 'A high-quality reference image.',
    n: 1,
    size: openaiSizeFor(ctx.model, ctx.aspect),
  };
  if (!azure) {
    body.model = ctx.model;
  }
  if (ctx.model.startsWith('dall-e-')) {
    body.response_format = 'b64_json';
    body.quality = ctx.model === 'dall-e-3' ? 'hd' : 'standard';
  } else {
    body.quality = 'high';
  }

  const headers: Record<string, string> = {
    'authorization': `Bearer ${credentials.apiKey}`,
    'content-type': 'application/json',
  };
  if (azure) {
    headers['api-key'] = credentials.apiKey;
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    const tag = azure ? 'azure-openai' : 'openai';
    throw new Error(`${tag} ${resp.status}: ${truncate(text, 240)}`);
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`openai non-JSON response: ${truncate(text, 200)}`);
  }
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!entry) throw new Error('openai response had no data[0]');
  let bytes;
  if (entry.b64_json) {
    bytes = Buffer.from(entry.b64_json, 'base64');
  } else if (entry.url) {
    const imgResp = await fetch(entry.url);
    if (!imgResp.ok) throw new Error(`openai image fetch ${imgResp.status}`);
    const arr = await imgResp.arrayBuffer();
    bytes = Buffer.from(arr);
  } else {
    throw new Error('openai response had neither b64_json nor url');
  }

  const tag = azure ? 'azure-openai' : 'openai';
  return {
    bytes,
    providerNote: `${tag}/${ctx.model} · ${ctx.aspect} · ${bytes.length} bytes`,
    suggestedExt: '.png',
  };
}

function detectAzureEndpoint(baseUrl: string): boolean {
  if (typeof baseUrl !== 'string' || !baseUrl) return false;
  if (/\.azure\.com\b/i.test(baseUrl)) return true;
  if (/\/openai\/deployments\//i.test(baseUrl)) return true;
  return false;
}

function buildOpenAIImageUrl(baseUrl: string, isAzure: boolean): string {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    const stripped = baseUrl.replace(/\/$/, '');
    return `${stripped}/images/generations`;
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/images/generations';
  if (isAzure && !parsed.searchParams.has('api-version')) {
    parsed.searchParams.set('api-version', AZURE_DEFAULT_API_VERSION);
  }
  return parsed.toString();
}

function openaiSizeFor(model: string, aspect?: string): string {
  if (model.startsWith('gpt-image-')) {
    if (aspect === '16:9') return '1792x1024';
    if (aspect === '9:16') return '1024x1792';
    if (aspect === '4:3') return '1408x1056';
    if (aspect === '3:4') return '1056x1408';
    return '1024x1024';
  }
  if (model === 'dall-e-3') {
    if (aspect === '16:9') return '1792x1024';
    if (aspect === '9:16') return '1024x1792';
    return '1024x1024';
  }
  return '1024x1024';
}

// ---------------------------------------------------------------------------
// Provider: Volcengine Ark — Doubao Seedream image
// ---------------------------------------------------------------------------

async function renderVolcengineImage(ctx: MediaContext, credentials: ProviderConfig): Promise<RenderResult> {
  if (!credentials.apiKey) {
    throw new Error('no Volcengine Ark API key — configure it in Settings or set ARK_API_KEY');
  }
  const baseUrl = (credentials.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');

  const body = {
    model: ctx.model,
    prompt: ctx.prompt || 'A high-quality reference image.',
    response_format: 'b64_json',
    size: openaiSizeFor(ctx.model, ctx.aspect),
  };
  const resp = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${credentials.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`volcengine image ${resp.status}: ${truncate(text, 240)}`);
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`volcengine image non-JSON: ${truncate(text, 200)}`);
  }
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!entry) throw new Error('volcengine image response had no data[0]');
  let bytes;
  if (entry.b64_json) {
    bytes = Buffer.from(entry.b64_json, 'base64');
  } else if (entry.url) {
    const imgResp = await fetch(entry.url);
    if (!imgResp.ok) throw new Error(`volcengine image fetch ${imgResp.status}`);
    bytes = Buffer.from(await imgResp.arrayBuffer());
  } else {
    throw new Error('volcengine image response missing b64_json/url');
  }
  return {
    bytes,
    providerNote: `volcengine/${ctx.model} · ${ctx.aspect} · ${bytes.length} bytes`,
    suggestedExt: '.png',
  };
}

// ---------------------------------------------------------------------------
// Provider: xAI Grok Imagine (image)
// ---------------------------------------------------------------------------

async function renderGrokImage(ctx: MediaContext, credentials: ProviderConfig): Promise<RenderResult> {
  if (!credentials.apiKey) {
    throw new Error(
      'no xAI API key — configure it in Settings or set XAI_API_KEY',
    );
  }
  const baseUrl = (credentials.baseUrl || 'https://api.x.ai/v1').replace(/\/$/, '');

  const aspectRatio = grokAspectFor(ctx.aspect);
  const body = {
    model: ctx.model,
    prompt: ctx.prompt || 'A high-quality reference image.',
    n: 1,
    aspect_ratio: aspectRatio,
    response_format: 'b64_json',
  };
  const resp = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${credentials.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`grok image ${resp.status}: ${truncate(text, 240)}`);
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`grok image non-JSON: ${truncate(text, 200)}`);
  }
  const entry = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!entry) throw new Error('grok image response had no data[0]');
  let bytes;
  if (entry.b64_json) {
    bytes = Buffer.from(entry.b64_json, 'base64');
  } else if (entry.url) {
    const imgResp = await fetch(entry.url);
    if (!imgResp.ok) throw new Error(`grok image fetch ${imgResp.status}`);
    bytes = Buffer.from(await imgResp.arrayBuffer());
  } else {
    throw new Error('grok image response missing b64_json/url');
  }
  return {
    bytes,
    providerNote: `grok/${ctx.model} · ${aspectRatio} · ${bytes.length} bytes`,
    suggestedExt: sniffImageExt(bytes),
  };
}

function grokAspectFor(aspect?: string): string {
  if (
    aspect === '1:1'
    || aspect === '16:9'
    || aspect === '9:16'
    || aspect === '4:3'
    || aspect === '3:4'
  ) {
    return aspect;
  }
  return '1:1';
}

// ---------------------------------------------------------------------------
// Provider: Nano Banana (Gemini image)
// ---------------------------------------------------------------------------

async function renderNanoBananaImage(ctx: MediaContext, credentials: ProviderConfig): Promise<RenderResult> {
  if (!credentials.apiKey) {
    throw new Error(
      'no Nano Banana API key — configure it in Settings or set OD_NANOBANANA_API_KEY',
    );
  }

  const baseUrl = (credentials.baseUrl || NANOBANANA_DEFAULT_BASE_URL).replace(/\/$/, '');
  const wireModel = (credentials.model || ctx.model || NANOBANANA_DEFAULT_MODEL).trim();
  const body = {
    contents: [{
      parts: [{
        text: ctx.prompt || 'A high-quality reference image.',
      }],
    }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: {
        aspectRatio: nanoBananaAspectFor(ctx.aspect),
        imageSize: NANOBANANA_DEFAULT_IMAGE_SIZE,
      },
    },
  };

  const resp = await fetch(`${baseUrl}/v1beta/models/${encodeURIComponent(wireModel)}:generateContent`, {
    method: 'POST',
    headers: nanoBananaHeaders(baseUrl, credentials.apiKey),
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`nano-banana image ${resp.status}: ${truncate(text, 240)}`);
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`nano-banana image non-JSON: ${truncate(text, 200)}`);
  }
  const bytes = inlineImageBytesFromGenerateContent(data);
  return {
    bytes,
    providerNote: `nano-banana/${wireModel} · ${nanoBananaAspectFor(ctx.aspect)} · ${NANOBANANA_DEFAULT_IMAGE_SIZE} · ${bytes.length} bytes`,
    suggestedExt: sniffImageExt(bytes),
  };
}

function nanoBananaHeaders(baseUrl: string, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (usesOfficialGoogleApiKeyHeader(baseUrl)) {
    headers['x-goog-api-key'] = apiKey;
    return headers;
  }
  headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function usesOfficialGoogleApiKeyHeader(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname === 'generativelanguage.googleapis.com';
  } catch {
    return false;
  }
}

function nanoBananaAspectFor(aspect?: string): string {
  if (
    aspect === '1:1'
    || aspect === '16:9'
    || aspect === '9:16'
    || aspect === '4:3'
    || aspect === '3:4'
  ) {
    return aspect;
  }
  return '1:1';
}

function inlineImageBytesFromGenerateContent(data: any): Buffer {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      const inline = part?.inlineData;
      if (typeof inline?.data === 'string' && inline.data) {
        return Buffer.from(inline.data, 'base64');
      }
    }
  }
  throw new Error('nano-banana image response missing candidates[].content.parts[].inlineData.data');
}

// ---------------------------------------------------------------------------
// Stub renderer (image only)
// ---------------------------------------------------------------------------

async function renderStub(ctx: MediaContext, fileName: string): Promise<RenderResult> {
  const note = ctx.provider && !ctx.provider.integrated
    ? `stub-${ctx.surface} · provider '${ctx.provider.id}' integration pending`
    : `stub-${ctx.surface} · model=${ctx.model}`;
  if (ctx.surface === 'image') {
    const ext = path.extname(fileName).toLowerCase();
    if (ext === '.svg') {
      return { bytes: Buffer.from(svgPlaceholder(ctx), 'utf8'), providerNote: note };
    }
    const png = Buffer.from(
      [
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ],
    );
    return {
      bytes: png,
      providerNote: `${note} · aspect=${ctx.aspect} · prompt=${truncate(ctx.prompt, 60)}`,
    };
  }
  throw new Error(`no stub renderer for surface "${ctx.surface}"`);
}

function svgPlaceholder(ctx: MediaContext): string {
  const [w, h] = aspectToBox(ctx.aspect, 800);
  const safe = (s: unknown): string =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`,
    `<rect width="${w}" height="${h}" fill="#0f1424"/>`,
    `<text x="50%" y="50%" fill="#7da4ff" font-family="ui-sans-serif" font-size="20" text-anchor="middle">${safe(ctx.model)} — ${safe(ctx.prompt).slice(0, 60)}</text>`,
    '</svg>',
  ].join('');
}

function aspectToBox(aspect: string | undefined, base: number): [number, number] {
  const [a, b] = String(aspect || '1:1').split(':').map(Number);
  if (!a || !b) return [base, base];
  if (a >= b) return [base, Math.round((base * b) / a)];
  return [Math.round((base * a) / b), base];
}

function sniffImageExt(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return '.jpg';
  }
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return '.png';
  }
  if (
    bytes.length >= 4
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
  ) {
    // Check WEBP signature at offset 8
    if (
      bytes.length >= 12
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
      return '.webp';
    }
  }
  return '.png';
}

function mimeFromExt(ext: string): string {
  const mime: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
  };
  return mime[ext.toLowerCase()] || 'application/octet-stream';
}

function truncate(s: unknown, n: number): string {
  const v = String(s || '');
  if (v.length <= n) return v;
  return v.slice(0, n - 1) + '…';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { defaultAspectFor };
