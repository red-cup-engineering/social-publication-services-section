import { createHash } from "node:crypto";

const MAX_TEXT_BYTES = 20_000;
const MAX_CARD_TITLE_BYTES = 300;
const MAX_CARD_DESCRIPTION_BYTES = 1_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const BLUESKY_POST_COLLECTION = "app.bsky.feed.post";

function authorizedCapability(value, provider) {
  if (typeof value !== "function") throw new TypeError(`${provider} operation requires an attenuated authorizedFetch capability`);
  return value;
}

function noAuthorization(headers = {}) {
  const names = headers instanceof Headers ? [...headers.keys()] : Object.keys(headers);
  if (names.some((name) => name.toLowerCase() === "authorization")) {
    throw new TypeError("authorization must be added by the customer capability, not supplied to the provider");
  }
}

function exactUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`${label} must be an absolute URL`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError(`${label} must use HTTP or HTTPS`);
  if (url.username || url.password) throw new TypeError(`${label} must not contain embedded credentials`);
  return url.href;
}

function serviceOrigin(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`${label} must be an absolute URL`); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new TypeError(`${label} must use HTTPS outside loopback development`);
  if (url.username || url.password || url.search || url.hash) throw new TypeError(`${label} must be an origin without credentials, query, or fragment`);
  url.pathname = "/";
  return url.origin;
}

function text(value, label, { required = true, maxBytes = MAX_TEXT_BYTES } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new TypeError(`${label} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const normalized = value.trim();
  if (required && normalized === "") throw new TypeError(`${label} must not be empty`);
  if (Buffer.byteLength(normalized) > maxBytes) throw new TypeError(`${label} exceeds its bounded size`);
  return normalized;
}

function isoInstant(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new TypeError(`${label} must be a finite ISO timestamp`);
  return new Date(value).toISOString();
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

export function niDigest(value) {
  const digest = createHash("sha256").update(stableJson(value)).digest("base64url");
  return `ni:///sha-256;${digest}`;
}

export function publicationIntent({ canonicalUrl, text: body, title, description, languages = ["en"], kind = "article" } = {}) {
  const canonical = exactUrl(canonicalUrl, "canonicalUrl");
  const message = text(body, "text");
  const normalizedTitle = text(title, "title", { required: false, maxBytes: MAX_CARD_TITLE_BYTES });
  const normalizedDescription = text(description, "description", { required: false, maxBytes: MAX_CARD_DESCRIPTION_BYTES });
  if (!Array.isArray(languages) || languages.length < 1 || languages.length > 8 || languages.some((lang) => typeof lang !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(lang))) {
    throw new TypeError("languages must be 1..8 BCP-47-like language tags");
  }
  if (!['article', 'update', 'analysis', 'announcement'].includes(kind)) throw new TypeError("kind is not an admitted publication intent kind");
  const bodyValue = Object.freeze({
    type: "SocialPublicationIntent",
    version: 1,
    canonicalUrl: canonical,
    text: message,
    ...(normalizedTitle === undefined ? {} : { title: normalizedTitle }),
    ...(normalizedDescription === undefined ? {} : { description: normalizedDescription }),
    languages: Object.freeze([...languages]),
    kind,
  });
  return Object.freeze({ id: niDigest(bodyValue), ...bodyValue });
}

async function boundedJson(response, operation) {
  const raw = await response.text();
  if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new TypeError(`${operation} response exceeds the bounded JSON limit`);
  if (!response.ok) throw new Error(`${operation} ${response.status}: ${raw.slice(0, 400)}`);
  try { return JSON.parse(raw); } catch { throw new TypeError(`${operation} returned malformed JSON`); }
}

export function publicationReceipt({ provider, intent, externalId, externalUrl, observedAt, responseDigest } = {}) {
  if (!['bluesky', 'facebook-page', 'linkedin', 'x'].includes(provider)) throw new TypeError("publication receipt provider is not admitted");
  if (!intent || intent.type !== "SocialPublicationIntent" || typeof intent.id !== "string" || !intent.id.startsWith("ni:///sha-256;")) throw new TypeError("publication receipt requires an admitted intent");
  const id = text(externalId, "externalId", { maxBytes: 500 });
  const url = externalUrl === undefined ? undefined : exactUrl(externalUrl, "externalUrl");
  const at = isoInstant(observedAt, "observedAt");
  const body = Object.freeze({
    type: "SocialPublicationReceipt",
    version: 1,
    provider,
    intent: intent.id,
    externalId: id,
    ...(url === undefined ? {} : { externalUrl: url }),
    observedAt: at,
    ...(responseDigest === undefined ? {} : { responseDigest }),
  });
  return Object.freeze({ id: niDigest(body), ...body });
}

function did(value) {
  if (typeof value !== "string" || !/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/u.test(value)) throw new TypeError("repoDid must be a DID");
  return value;
}

function graphemeCount(value) {
  return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value)].length;
}

function blueskyBlob(value) {
  if (!value || typeof value !== "object" || value.$type !== "blob" || typeof value.mimeType !== "string" || !Number.isInteger(value.size) || value.size < 1 || typeof value.ref !== "object" || typeof value.ref.$link !== "string") {
    throw new TypeError("Bluesky blob response is malformed");
  }
  return value;
}

export function blueskyPostRecord({ intent, createdAt, externalCard, externalThumb } = {}) {
  if (!intent || intent.type !== "SocialPublicationIntent") throw new TypeError("Bluesky post requires a SocialPublicationIntent");
  if (Buffer.byteLength(intent.text) > 3000 || graphemeCount(intent.text) > 300) throw new TypeError("Bluesky post text exceeds the app.bsky.feed.post limit");
  if (intent.languages.length > 3) throw new TypeError("Bluesky post admits at most three languages");
  const record = {
    $type: BLUESKY_POST_COLLECTION,
    text: intent.text,
    createdAt: isoInstant(createdAt, "createdAt"),
    langs: [...intent.languages],
  };
  if (externalCard !== undefined) {
    const uri = exactUrl(externalCard.uri ?? intent.canonicalUrl, "externalCard.uri");
    const titleValue = text(externalCard.title ?? intent.title ?? new URL(uri).hostname, "externalCard.title", { maxBytes: MAX_CARD_TITLE_BYTES });
    const descriptionValue = text(externalCard.description ?? intent.description ?? "", "externalCard.description", { required: false, maxBytes: MAX_CARD_DESCRIPTION_BYTES }) ?? "";
    record.embed = {
      $type: "app.bsky.embed.external",
      external: {
        uri,
        title: titleValue,
        description: descriptionValue,
        ...(externalThumb === undefined ? {} : { thumb: blueskyBlob(externalThumb) }),
      },
    };
  }
  return Object.freeze(record);
}

export async function uploadBlueskyBlob({ authorizedFetch, service = "https://bsky.social", bytes, mediaType = "image/png" } = {}) {
  const call = authorizedCapability(authorizedFetch, "Bluesky");
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 2_000_000) throw new TypeError("Bluesky blob must be 1..2,000,000 bytes");
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mediaType)) throw new TypeError("Bluesky blob media type is not admitted");
  const origin = serviceOrigin(service, "Bluesky service");
  const init = { method: "POST", redirect: "error", headers: { "content-type": mediaType, accept: "application/json" }, body: bytes };
  noAuthorization(init.headers);
  const payload = await boundedJson(await call(`${origin}/xrpc/com.atproto.repo.uploadBlob`, init), "com.atproto.repo.uploadBlob");
  return blueskyBlob(payload.blob);
}

export async function publishBlueskyPost({ authorizedFetch, service = "https://bsky.social", repoDid, record } = {}) {
  const call = authorizedCapability(authorizedFetch, "Bluesky");
  const origin = serviceOrigin(service, "Bluesky service");
  const repo = did(repoDid);
  if (!record || record.$type !== BLUESKY_POST_COLLECTION || typeof record.text !== "string" || !Number.isFinite(Date.parse(record.createdAt ?? ""))) throw new TypeError("record is not an admitted Bluesky feed post");
  const init = {
    method: "POST", redirect: "error", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ repo, collection: BLUESKY_POST_COLLECTION, record }),
  };
  noAuthorization(init.headers);
  const payload = await boundedJson(await call(`${origin}/xrpc/com.atproto.repo.createRecord`, init), "com.atproto.repo.createRecord");
  if (typeof payload.uri !== "string" || !payload.uri.startsWith(`at://${repo}/${BLUESKY_POST_COLLECTION}/`) || typeof payload.cid !== "string" || payload.cid.length < 10) {
    throw new TypeError("Bluesky createRecord returned no exact URI/CID receipt");
  }
  return Object.freeze({ uri: payload.uri, cid: payload.cid, response: payload });
}

export async function resolveBlueskyHandle({ fetch: request = globalThis.fetch, service = "https://bsky.social", handle } = {}) {
  if (typeof request !== "function") throw new TypeError("resolveBlueskyHandle requires fetch");
  if (typeof handle !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{1,251}[A-Za-z0-9])?$/u.test(handle)) throw new TypeError("handle is malformed");
  const origin = serviceOrigin(service, "Bluesky service");
  const url = `${origin}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`;
  const payload = await boundedJson(await request(url, { method: "GET", redirect: "error", headers: { accept: "application/json" } }), "com.atproto.identity.resolveHandle");
  return Object.freeze({ handle, did: did(payload.did) });
}

function facebookVersion(value) {
  if (typeof value !== "string" || !/^v\d{1,3}\.\d{1,3}$/u.test(value)) throw new TypeError("Facebook apiVersion must be explicit vMAJOR.MINOR text");
  return value;
}

function facebookPageId(value) {
  if (typeof value !== "string" || !/^\d{5,40}$/u.test(value)) throw new TypeError("Facebook pageId must be numeric text");
  return value;
}

export async function observeFacebookPage({ authorizedFetch, graphOrigin = "https://graph.facebook.com", apiVersion, pageId } = {}) {
  const call = authorizedCapability(authorizedFetch, "Facebook");
  const origin = serviceOrigin(graphOrigin, "Facebook graphOrigin");
  const version = facebookVersion(apiVersion);
  const id = facebookPageId(pageId);
  const init = { method: "GET", redirect: "error", headers: { accept: "application/json" } };
  noAuthorization(init.headers);
  const payload = await boundedJson(await call(`${origin}/${version}/${id}?fields=id%2Cname%2Clink`, init), "Facebook Page observation");
  if (String(payload.id) !== id || typeof payload.name !== "string") throw new TypeError("Facebook Page observation did not return the exact page");
  return Object.freeze({ id, name: payload.name, ...(typeof payload.link === "string" ? { link: exactUrl(payload.link, "Facebook Page link") } : {}) });
}

export async function publishFacebookPagePost({ authorizedFetch, graphOrigin = "https://graph.facebook.com", apiVersion, pageId, message, link } = {}) {
  const call = authorizedCapability(authorizedFetch, "Facebook");
  const origin = serviceOrigin(graphOrigin, "Facebook graphOrigin");
  const version = facebookVersion(apiVersion);
  const id = facebookPageId(pageId);
  const body = new URLSearchParams();
  body.set("message", text(message, "message"));
  if (link !== undefined) body.set("link", exactUrl(link, "link"));
  const init = { method: "POST", redirect: "error", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString() };
  noAuthorization(init.headers);
  const payload = await boundedJson(await call(`${origin}/${version}/${id}/feed`, init), "Facebook Page feed publication");
  if (typeof payload.id !== "string" || payload.id.length < 3 || payload.id.length > 256) throw new TypeError("Facebook Page publication returned no post id");
  return Object.freeze({ id: payload.id, response: payload });
}


function linkedinVersion(value) {
  if (typeof value !== "string" || !/^20\d{4}$/u.test(value)) throw new TypeError("LinkedIn version must be explicit YYYYMM text");
  const month = Number(value.slice(4));
  if (month < 1 || month > 12) throw new TypeError("LinkedIn version contains an invalid month");
  return value;
}

function linkedinAuthor(value) {
  if (typeof value !== "string" || !/^urn:li:(?:organization:\d+|person:[A-Za-z0-9_-]+)$/u.test(value)) throw new TypeError("LinkedIn author must be an organization or person URN");
  return value;
}

function linkedinImageUrn(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^urn:li:image:[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError("LinkedIn thumbnail must be an image URN");
  return value;
}

export function linkedinPostBody({ intent, author, article = true, thumbnail } = {}) {
  if (!intent || intent.type !== "SocialPublicationIntent") throw new TypeError("LinkedIn post requires a SocialPublicationIntent");
  const body = {
    author: linkedinAuthor(author),
    commentary: intent.text,
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  if (article) {
    const titleValue = text(intent.title, "LinkedIn article title", { maxBytes: MAX_CARD_TITLE_BYTES });
    const descriptionValue = text(intent.description, "LinkedIn article description", { maxBytes: MAX_CARD_DESCRIPTION_BYTES });
    const thumb = linkedinImageUrn(thumbnail);
    body.content = { article: { source: intent.canonicalUrl, title: titleValue, description: descriptionValue, ...(thumb === undefined ? {} : { thumbnail: thumb }) } };
  }
  return Object.freeze(body);
}

export async function publishLinkedInPost({ authorizedFetch, apiOrigin = "https://api.linkedin.com", version, body } = {}) {
  const call = authorizedCapability(authorizedFetch, "LinkedIn");
  const origin = serviceOrigin(apiOrigin, "LinkedIn apiOrigin");
  const admittedVersion = linkedinVersion(version);
  if (!body || typeof body !== "object" || !linkedinAuthor(body.author) || typeof body.commentary !== "string" || body.lifecycleState !== "PUBLISHED" || body.visibility !== "PUBLIC") {
    throw new TypeError("LinkedIn body is not an admitted public post");
  }
  const init = {
    method: "POST", redirect: "error",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-restli-protocol-version": "2.0.0",
      "linkedin-version": admittedVersion,
    },
    body: JSON.stringify(body),
  };
  noAuthorization(init.headers);
  const response = await call(`${origin}/rest/posts`, init);
  const raw = await response.text();
  if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new TypeError("LinkedIn Posts response exceeds the bounded response limit");
  if (response.status !== 201) throw new Error(`LinkedIn Posts ${response.status}: ${raw.slice(0, 400)}`);
  const postUrn = response.headers.get("x-restli-id");
  if (postUrn === null || !/^urn:li:(?:share|ugcPost):\d+$/u.test(postUrn)) throw new TypeError("LinkedIn Posts returned no exact post URN receipt");
  return Object.freeze({ id: postUrn });
}


/**
 * POSSE projection for X. The actual canonical article must already have
 * been accepted, published, and independently observed by the customer.
 * These pure preflight checks neither decide editorial rights nor create a
 * post; they always carry the exact original URL back into the short text.
 *
 * X counts Unicode and URL characters by its own rules. This conservative
 * 280-weight bound may reject some valid posts; it never silently truncates a
 * canonical link or promises eligibility for a particular account or API plan.
 */
function conservativeXLength(value) {
  return [...value].reduce((total, character) =>
    total + (character.codePointAt(0) > 0x10ff ? 2 : 1), 0);
}

export function xPostBody({ intent, commentary } = {}) {
  if (!intent || intent.type !== "SocialPublicationIntent") {
    throw new TypeError("X POSSE requires an original SocialPublicationIntent");
  }
  const canonical = new URL(intent.canonicalUrl);
  if (canonical.protocol !== "https:" || canonical.username || canonical.password) {
    throw new TypeError("X POSSE requires a published HTTPS canonical URL");
  }
  const message = text(commentary ?? intent.text, "X commentary");
  const posted = message.includes(canonical.href)
    ? message : message + "\n\n" + canonical.href;
  if (conservativeXLength(posted) > 280) {
    throw new TypeError("X POSSE post exceeds a conservative 280-weight limit; provide authored shorter copy");
  }
  return Object.freeze({ text: posted });
}

/**
 * The customer's attenuated user-context capability owns authorization.
 * X's successful CREATE result identifies a submitted remote post, not a
 * verified public reading, independently accepted delivery, or source update.
 * The customer's original publication journal must receive the result.
 *
 * API source: https://docs.x.com/x-api/posts/create-post
 */
export async function publishXPost({
  authorizedFetch, apiOrigin = "https://api.x.com", body,
} = {}) {
  const call = authorizedCapability(authorizedFetch, "X");
  const origin = serviceOrigin(apiOrigin, "X apiOrigin");
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      typeof body.text !== "string" || !body.text.trim() ||
      conservativeXLength(body.text) > 280) {
    throw new TypeError("X needs a bounded admitted text post");
  }
  const init = {
    method: "POST", redirect: "error",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ text: body.text }),
  };
  noAuthorization(init.headers);
  const response = await call(origin + "/2/tweets", init);
  if (response.status !== 201) {
    // Keep the original bounded error diagnostics, not a pretend receipt.
    const raw = await response.text();
    if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new TypeError("X response exceeds the bounded limit");
    throw new Error("X create post " + response.status + ": " + raw.slice(0, 400));
  }
  const payload = await boundedJson(response, "X create post");
  const id = payload?.data?.id;
  if (typeof id !== "string" || !/^\d{1,25}$/u.test(id) ||
      typeof payload.data.text !== "string" ||
      payload.data.text.length > MAX_TEXT_BYTES) {
    throw new TypeError("X returned no exact post id and text receipt");
  }
  return Object.freeze({ id, text: payload.data.text });
}
