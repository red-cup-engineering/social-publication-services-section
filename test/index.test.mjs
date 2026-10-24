import test from "node:test";
import assert from "node:assert/strict";
import {
  blueskyPostRecord,
  linkedinPostBody,
  niDigest,
  observeFacebookPage,
  publicationIntent,
  publicationReceipt,
  publishBlueskyPost,
  publishFacebookPagePost,
  publishLinkedInPost,
  resolveBlueskyHandle,
  uploadBlueskyBlob,
  xPostBody,
  publishXPost,
} from "../src/index.mjs";

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

test("publication intents and receipts are ni-addressed and deterministic", () => {
  const intent = publicationIntent({ canonicalUrl: "https://koios.news/posts/example", text: "A quiet update.", title: "Example", description: "Evidence first." });
  assert.match(intent.id, /^ni:\/\/\/sha-256;[A-Za-z0-9_-]+$/u);
  assert.equal(intent.id, publicationIntent({ canonicalUrl: "https://koios.news/posts/example", text: "A quiet update.", title: "Example", description: "Evidence first." }).id);
  const receipt = publicationReceipt({ provider: "bluesky", intent, externalId: "at://did:plc:abc/app.bsky.feed.post/xyz", observedAt: "2026-10-06T00:00:00Z" });
  assert.match(receipt.id, /^ni:\/\/\/sha-256;/u);
  assert.equal(niDigest({ b: 2, a: 1 }), niDigest({ a: 1, b: 2 }));
});

test("Bluesky post creation is credential-blind and exact-receipt checked", async () => {
  const intent = publicationIntent({ canonicalUrl: "https://koios.news/posts/example", text: "Watching the future take shape.", title: "Example", description: "The record changed." });
  const record = blueskyPostRecord({ intent, createdAt: "2026-10-06T01:02:03Z", externalCard: {} });
  let seen;
  const result = await publishBlueskyPost({
    repoDid: "did:plc:abcdefghijklmnop",
    record,
    authorizedFetch: async (url, init) => {
      seen = { url, init };
      return response({ uri: "at://did:plc:abcdefghijklmnop/app.bsky.feed.post/3abc", cid: "bafyrei0123456789" });
    },
  });
  assert.equal(seen.url, "https://bsky.social/xrpc/com.atproto.repo.createRecord");
  assert.equal(seen.init.headers.authorization, undefined);
  assert.match(seen.init.body, /app\.bsky\.feed\.post/u);
  assert.equal(result.cid, "bafyrei0123456789");
});

test("Bluesky blob upload stays bounded and returns a validated blob", async () => {
  const blob = await uploadBlueskyBlob({
    bytes: new Uint8Array([1,2,3,4]),
    authorizedFetch: async () => response({ blob: { $type: "blob", ref: { $link: "bafkabc" }, mimeType: "image/png", size: 4 } }),
  });
  assert.equal(blob.ref.$link, "bafkabc");
});

test("Bluesky handle resolution is public and provider-independent", async () => {
  const value = await resolveBlueskyHandle({ handle: "koios.news", fetch: async () => response({ did: "did:plc:abcdefghijklmnop" }) });
  assert.equal(value.did, "did:plc:abcdefghijklmnop");
});

test("Facebook Page observation and publication require explicit API version and page identity", async () => {
  const calls=[];
  const authorizedFetch=async (url, init) => {
    calls.push({url,init});
    if (init.method === "GET") return response({ id: "61573083309686", name: "Koios.News", link: "https://www.facebook.com/koios.news" });
    return response({ id: "61573083309686_123456789" });
  };
  const page=await observeFacebookPage({ authorizedFetch, apiVersion:"v24.0", pageId:"61573083309686" });
  assert.equal(page.name,"Koios.News");
  const post=await publishFacebookPagePost({ authorizedFetch, apiVersion:"v24.0", pageId:"61573083309686", message:"Watching the future take shape.", link:"https://koios.news/" });
  assert.equal(post.id,"61573083309686_123456789");
  assert.equal(calls[1].init.headers.authorization, undefined);
  assert.match(calls[1].init.body,/koios\.news/u);
});


test("Bluesky post construction enforces current lexicon bounds", () => {
  const tooLong = publicationIntent({ canonicalUrl: "https://koios.news/", text: "x".repeat(301) });
  assert.throws(() => blueskyPostRecord({ intent: tooLong, createdAt: "2026-10-06T00:00:00Z" }), /app\.bsky\.feed\.post limit/u);
  const tooManyLanguages = publicationIntent({ canonicalUrl: "https://koios.news/", text: "hello", languages: ["en", "fr", "de", "es"] });
  assert.throws(() => blueskyPostRecord({ intent: tooManyLanguages, createdAt: "2026-10-06T00:00:00Z" }), /at most three languages/u);
});

test("LinkedIn post publication is versioned, credential-blind, and receipt checked", async () => {
  const intent = publicationIntent({ canonicalUrl: "https://koios.news/posts/example", text: "A systems update.", title: "Example", description: "What changed and why it matters." });
  const body = linkedinPostBody({ intent, author: "urn:li:organization:5515715" });
  let seen;
  const id = "urn:li:share:6844785523593134080";
  const result = await publishLinkedInPost({
    version: "202609", body,
    authorizedFetch: async (url, init) => {
      seen = { url, init };
      return new Response("", { status: 201, headers: { "x-restli-id": id } });
    },
  });
  assert.equal(seen.url, "https://api.linkedin.com/rest/posts");
  assert.equal(seen.init.headers.authorization, undefined);
  assert.equal(seen.init.headers["linkedin-version"], "202609");
  assert.equal(result.id, id);
});


test("X POSSE copy always retains the authored canonical source link", () => {
  const intent = publicationIntent({
    canonicalUrl: "https://science.561.group/research/jiangshi-web",
    text: "Why does a corrected source keep being cited incorrectly?",
    title: "The Jiangshi Web", description: "Research on accountable Web repair",
  });
  const body = xPostBody({ intent });
  assert.equal(body.text, intent.text + "\n\n" + intent.canonicalUrl);
  assert.equal(Object.isFrozen(body), true);
  assert.equal(xPostBody({ intent, commentary: "A short reading: " + intent.canonicalUrl }).text,
    "A short reading: " + intent.canonicalUrl,
    "explicit original links must not be duplicated");
  assert.throws(() => xPostBody({ intent, commentary: "a".repeat(280) }),
    /conservative 280-weight limit/u, "do not silently truncate an accepted article URL");
  assert.throws(() => xPostBody({ intent: publicationIntent({
    canonicalUrl: "http://unpublished.example/draft", text: "Draft",
  }) }), /published HTTPS canonical/u);
});

test("X user-context publisher returns only an exact remote CREATE receipt", async () => {
  const intent = publicationIntent({
    canonicalUrl: "https://science.561.group/research/jiangshi-web",
    text: "A source's correction should follow its copies.",
  });
  const body = xPostBody({ intent });
  let call;
  const id = "1829384756102938475";
  const result = await publishXPost({
    body,
    authorizedFetch: async (url, init) => {
      call = { url, init };
      return response({ data: { id, text: body.text } }, { status: 201 });
    },
  });
  assert.equal(call.url, "https://api.x.com/2/tweets");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.headers.authorization, undefined, "customer adds OAuth in the attenuated capability");
  assert.equal(JSON.parse(call.init.body).text, body.text);
  assert.deepEqual(result, { id, text: body.text });
  const receipt = publicationReceipt({
    provider: "x", intent, externalId: result.id, observedAt: "2026-10-22T21:00:00Z",
  });
  assert.equal(receipt.provider, "x");
  assert.equal(receipt.intent, intent.id);
  assert.ok(receipt.id.startsWith("ni:///sha-256;"));
});

test("X refuses API errors and malformed receipts without claiming a published URL", async () => {
  const body = { text: "Valid short canonical link https://science.561.group/" };
  const call = authorizedFetch => publishXPost({ body, authorizedFetch });
  await assert.rejects(call(async () => response({ error: "no account authority" }, { status: 403 })),
    /X create post 403/u);
  for (const malformed of [
    { data: { id: "not-a-post", text: body.text } },
    { data: { id: "12345" } },
    { data: null },
  ]) {
    await assert.rejects(call(async () => response(malformed, { status: 201 })),
      /exact post id and text/u);
  }
  await assert.rejects(publishXPost({ body, authorizedFetch: null }),
    /attenuated authorizedFetch/u);
  await assert.rejects(publishXPost({
    body: { text: "x".repeat(281) }, authorizedFetch: async () => { throw Error("never call provider"); },
  }), /bounded admitted text/u);
});
